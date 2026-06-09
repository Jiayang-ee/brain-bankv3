// paper_extract.js — 把 OpenAlex / Crossref 归一化后的 paper → 写入 SQLite 的 paper / paper_author 记录。
//
// 设计：
//   - paperId:   doi 存在时 = "doi:<lowercased>"；否则 = "sha1:"+sha1(source|normalized_title|year|journal_id).slice(0,32)
//   - authorId:  sha1(paperId|author_position|normalized_name) — 同位置同人重抓幂等
//   - target_candidate = (is_first_author OR is_last_author OR is_corresponding) AND chinese_likely
//   - chinese 评分复用 chinese.js 的 looksChinese()，阈值可调
//
// 公开：
//   - buildPaperId({ doi, title, year, source, journalId })
//   - buildAuthorId({ paperId, position, name })
//   - extractAuthorships({ work, paperId, journalId, threshold })
//   - extractPaperRecord({ work, journalId, journalName, source, issn })
//   - chineseLikely(work)  快捷判断

'use strict';

const crypto = require('node:crypto');
const { looksChinese } = require('./chinese.js');
const { extractEmailForAuthor } = require('./email_extract.js');

function normalizeTitle(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[\u2010-\u2015\u2012-\u2014\u2212]/g, '-')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .slice(0, 256);
}

function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 规范化 doi：去 "https://doi.org/" / "http://dx.doi.org/" 前缀，全部小写
function normalizeDoi(s) {
  if (!s) return null;
  return String(s)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .toLowerCase()
    .trim() || null;
}

function buildPaperId({ doi, title, year, source, journalId }) {
  if (doi) {
    return `doi:${String(doi).toLowerCase().trim()}`;
  }
  const norm = [source || '', journalId || '', String(year || ''), normalizeTitle(title)].join('|');
  return `sha1:${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 32)}`;
}

function buildAuthorId({ paperId, position, name }) {
  return crypto.createHash('sha1')
    .update(`${paperId}|${position}|${normalizeName(name)}`)
    .digest('hex');
}

function isTargetAuthor(author) {
  return Boolean(author.is_first_author || author.is_last_author || author.is_corresponding);
}

// 评分 + 命中原因
function scoreAuthorName(name) {
  return looksChinese({ name: name || '', threshold: 0 });
}

// 解析 OpenAlex 的 authorship（每个含有 author.position / author.display_name 等）
// Crossref 的已经在 crossref.js 中预归一化过了。
function normalizeAuthorship(auth, total, idxFallback) {
  if (!auth) return null;
  const name = auth.name || (auth.author && auth.author.display_name) || null;
  if (!name) return null;
  const idx = typeof auth.position === 'string'
    ? auth.position
    : (typeof idxFallback === 'number' ? idxFallback : 0);
  let position = 0;
  if (typeof idx === 'string') {
    // OpenAlex 'first' / 'middle' / 'last'
    if (idx === 'first') position = 0;
    else if (idx === 'last') position = total > 0 ? total - 1 : 0;
    else if (idx === 'middle') position = Math.max(1, Math.floor((total || 1) / 2));
    else position = 0;
  } else {
    position = idx;
  }
  // OpenAlex: auth.author.display_name
  //           auth.is_corresponding
  //           auth.raw_affiliation_strings (string[] — 实际字段名带 s)
  //           auth.institutions[].id, .display_name
  const isFirst = auth.is_first_author || position === 0 || idx === 'first';
  const isLast = auth.is_last_author || position === total - 1 || idx === 'last';
  const isCorresponding = Boolean(auth.is_corresponding);
  // raw_affiliation_strings 是数组；join 供下游 regex / 启发式打分用
  // 保留 fallback 以兼容 Crossref / 历史数据（Crossref 的 affiliation 是 [{name}]）
  let affiliationRaw = null;
  if (Array.isArray(auth.raw_affiliation_strings) && auth.raw_affiliation_strings.length > 0) {
    affiliationRaw = auth.raw_affiliation_strings.join('; ');
  } else if (typeof auth.raw_affiliation_string === 'string' && auth.raw_affiliation_string) {
    affiliationRaw = auth.raw_affiliation_string;  // 旧 / fallback
  } else if (auth.affiliation_raw) {
    affiliationRaw = auth.affiliation_raw;          // 显式传入
  }
  return {
    name,
    position: Number(position) || 0,
    is_first_author: Boolean(isFirst),
    is_last_author: Boolean(isLast),
    is_corresponding: isCorresponding,
    affiliation_raw: affiliationRaw,
    affiliation_id: (auth.institutions && auth.institutions[0] && auth.institutions[0].id) || auth.affiliation_id || null,
    affiliation_name: (auth.institutions && auth.institutions[0] && auth.institutions[0].display_name)
      || auth.affiliation_name || null,
    orcid: auth.orcid || (auth.author && auth.author.orcid) || null,
  };
}

// 把 paper 的 authorships 全部展平为 paper_authors 写入行
// work: normalizeWork() 的输出
// paperId: buildPaperId 结果
// journalId: 关联 journals.id
// threshold: chinese_name_probability 阈值（默认 0.4）
function extractAuthorships({ work, paperId, threshold = 0.4 }) {
  const auths = (work && work.authorships) || [];
  const total = auths.length;
  const out = [];
  for (let i = 0; i < auths.length; i += 1) {
    const norm = normalizeAuthorship(auths[i], total, i);
    if (!norm || !norm.name) continue;
    const score = scoreAuthorName(norm.name);
    const isTarget = isTargetAuthor(norm) && (score.probability >= threshold);
    // BRA-9.1 path A：从 affiliation_raw 抽邮箱（OpenAlex regex 兜底）
    const emailHit = extractEmailForAuthor({ author: { affiliation_raw: norm.affiliation_raw } });
    out.push({
      id: buildAuthorId({ paperId, position: norm.position, name: norm.name }),
      paperId,
      authorName: norm.name,
      authorPosition: norm.position,
      isFirstAuthor: norm.is_first_author,
      isLastAuthor: norm.is_last_author,
      isCorresponding: norm.is_corresponding,
      affiliationRaw: norm.affiliation_raw,
      affiliationId: norm.affiliation_id,
      affiliationName: norm.affiliation_name,
      orcid: norm.orcid,
      chineseNameProbability: score.probability,
      chineseNameReasons: score.reasons || [],
      chineseNameNegatives: score.negatives || [],
      isTargetCandidate: isTarget,
      emailRaw: emailHit ? emailHit.email : null,
      emailSource: emailHit ? emailHit.source : null,
      emailMatchContext: emailHit ? emailHit.context : null,
    });
  }
  return out;
}

// 构造 paper 写入行
function extractPaperRecord({ work, journalId, journalName, source, issn }) {
  if (!work) return null;
  const cleanDoi = normalizeDoi(work.doi);
  const paperId = buildPaperId({
    doi: cleanDoi,
    title: work.title,
    year: work.publish_year,
    source,
    journalId,
  });
  return {
    id: paperId,
    doi: cleanDoi,
    openalexId: source === 'openalex' ? (work.id || null) : null,
    title: work.title || '(untitled)',
    journalId,
    journalName: journalName || work.source_name || '',
    issn: issn || work.issn_l || null,
    publishYear: work.publish_year || null,
    publishDate: work.publish_date || null,
    volume: work.volume || null,
    issue: work.issue || null,
    page: (work.page_first || work.page_last) ? `${work.page_first || ''}${work.page_last ? '-' + work.page_last : ''}` : null,
    paperType: work.type || null,
    citedByCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : null,
    language: work.language || null,
    source,
    sourceUrl: work.id || (cleanDoi ? `https://doi.org/${cleanDoi}` : null),
  };
}

module.exports = {
  buildPaperId,
  buildAuthorId,
  extractAuthorships,
  extractPaperRecord,
  normalizeTitle,
  normalizeName,
  normalizeDoi,
  isTargetAuthor,
  scoreAuthorName,
};
