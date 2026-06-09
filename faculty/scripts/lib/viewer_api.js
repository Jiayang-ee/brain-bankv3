// viewer_api.js — 本地网页查看器数据层 (BRA-10)。
//
// 零第三方依赖，只用 node:sqlite + node:fs + node:path。
//
// 公开：
//   - openDatabase(dbPath)              → DatabaseSync
//   - hasPaperAuthorReviewColumns(db)  → { review_status, review_notes } | {}
//   - listCandidates(db, source, q)     → { rows, total, page, page_size }
//   - getCandidate(db, source, id)      → row | null (含 paper/journal 关联)
//   - updateFacultyReview(db, id, p)    → { updated, status, notes }
//   - updatePaperReview(db, id, p)      → { updated, status, notes, persisted }
//   - getFacets(db)                     → 维度字典（学校/院系/审核状态/...）
//   - getStats(db)                      → 顶层计数（两表 + 状态分布）
//
// q (query) 形如：
//   {
//     review_status: ['pending', 'confirmed'] | null,
//     school_rank:   [1, 7] | null,
//     department_id: ['mit-sloan'] | null,
//     category:      ['business_school'] | null,
//     min_chs:       0.4,                 // 默认 0
//     max_chs:       1.0,                 // 默认 1
//     q:             'wang',              // 关键词，跨 name/title/email/affiliation
//     page:          1,                   // 1-based
//     page_size:     50,                  // 默认 50，最大 200
//     sort:          'chs_desc' | 'name_asc' | 'recent_desc',
//   }

'use strict';

const fs = require('node:fs');
const sqlite = require('node:sqlite');

const REVIEW_STATUSES = ['pending', 'confirmed', 'excluded', 'focus'];
const DEFAULT_SORT = 'chs_desc';

function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    const e = new Error(`faculty.db not found: ${dbPath}`);
    e.code = 'ENOENT';
    throw e;
  }
  return new sqlite.DatabaseSync(dbPath, { readOnly: false });
}

function closeDatabase(db) {
  try { db.close(); } catch (_) { /* ignore */ }
}

// 论文作者表是否已包含审核字段（BRA-23 负责添加；缺失时降级为只读）
function hasPaperAuthorReviewColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(paper_authors)').all().map((c) => c.name));
  const out = {};
  if (cols.has('review_status')) out.review_status = true;
  if (cols.has('review_notes')) out.review_notes = true;
  return out;
}

function safeJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

// ─── 过滤器规范化 ───────────────────────────────────────────

function normalizeQuery(input) {
  const q = input || {};
  const arr = (v) => {
    if (v == null || v === '') return null;
    if (Array.isArray(v)) return v.filter((x) => x !== '' && x != null);
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
  };
  const num = (v, def) => {
    if (v == null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    review_status: arr(q.review_status),
    school_rank: arr(q.school_rank)?.map((x) => Number(x)).filter((x) => Number.isFinite(x)) || null,
    department_id: arr(q.department_id),
    category: arr(q.category),
    min_chs: num(q.min_chs, 0),
    max_chs: num(q.max_chs, 1),
    q: q.q ? String(q.q).trim() : null,
    page: Math.max(1, Math.floor(num(q.page, 1))),
    page_size: Math.min(200, Math.max(1, Math.floor(num(q.page_size, 50)))),
    sort: ['chs_desc', 'name_asc', 'recent_desc'].includes(q.sort) ? q.sort : DEFAULT_SORT,
  };
}

// ─── where 子句构建器 ──────────────────────────────────────────

function buildWhere(q, opts = {}) {
  const where = [];
  const params = {};
  if (opts.source === 'faculty') {
    where.push("source_kind = 'personal_page'");
  } else if (opts.source === 'paper') {
    where.push('is_target_candidate = 1');
  } else {
    where.push("(source_kind = 'personal_page' OR is_target_candidate = 1)");
  }
  if (q.review_status && q.review_status.length) {
    where.push(`review_status IN (${q.review_status.map((_, i) => `@rs${i}`).join(',')})`);
    q.review_status.forEach((v, i) => { params[`rs${i}`] = v; });
  }
  if (q.school_rank && q.school_rank.length) {
    where.push(`school_rank IN (${q.school_rank.map((_, i) => `@sr${i}`).join(',')})`);
    q.school_rank.forEach((v, i) => { params[`sr${i}`] = v; });
  }
  if (q.department_id && q.department_id.length) {
    where.push(`department_id IN (${q.department_id.map((_, i) => `@di${i}`).join(',')})`);
    q.department_id.forEach((v, i) => { params[`di${i}`] = v; });
  }
  if (q.category && q.category.length) {
    where.push(`category IN (${q.category.map((_, i) => `@cat${i}`).join(',')})`);
    q.category.forEach((v, i) => { params[`cat${i}`] = v; });
  }
  if (Number.isFinite(q.min_chs) && q.min_chs > 0) {
    where.push('chinese_name_probability >= @minChs');
    params.minChs = q.min_chs;
  }
  if (Number.isFinite(q.max_chs) && q.max_chs < 1) {
    where.push('chinese_name_probability <= @maxChs');
    params.maxChs = q.max_chs;
  }
  if (q.q) {
    // 关键词搜索：faculty 候选用 title_raw 当职位，paper 候选把 affiliation 放进 title_raw；
    // email_raw 在 faculty 是邮箱，在 paper 是 ORCID；两端都有 name_raw。
    where.push('(name_raw LIKE @kw OR title_raw LIKE @kw OR email_raw LIKE @kw)');
    params.kw = `%${q.q}%`;
  }
  return { whereSql: where.join(' AND '), params };
}

function buildOrderBy(q) {
  switch (q.sort) {
    case 'name_asc':
      return 'name_raw COLLATE NOCASE ASC, chinese_name_probability DESC';
    case 'recent_desc':
      return 'last_seen_at DESC, chinese_name_probability DESC';
    case 'chs_desc':
    default:
      return 'chinese_name_probability DESC, last_seen_at DESC';
  }
}

// ─── 候选人表映射 (faculty) ─────────────────────────────────

// 派生 base view：candidates 行 + paper_authors 行对齐为统一字段
//
// candidates 表当前 schema 没有 chinese_name_negatives 列（仅 paper_authors 有）；
// paper_authors 表的 review_status / review_notes 由 BRA-23 添加，缺列时降级处理。
// 因此两个 base view 都用动态列探测：缺列 → 该列填 NULL。
function buildFacultyBase(hasNegatives) {
  const negCol = hasNegatives ? 'chinese_name_negatives' : "NULL AS chinese_name_negatives";
  return `
    SELECT
      id, school_rank, school_name_en, department_id, department_name_en,
      category, 'faculty' AS source, source_kind, source_url, source_list_url,
      local_path,
      name_raw, title_raw, email_raw,
      chinese_name_probability, chinese_name_reasons, ${negCol},
      review_status, review_notes,
      first_seen_at, last_seen_at, crawl_status,
      headshot_url, headshot_local_path, headshot_crawl_status,
      0 AS is_target_candidate,
      NULL AS paper_id, NULL AS paper_title, NULL AS paper_journal_id,
      NULL AS paper_journal_name, NULL AS paper_publish_year, NULL AS paper_publish_date,
      NULL AS paper_author_position, 0 AS paper_is_first_author, 0 AS paper_is_last_author,
      0 AS paper_is_corresponding, NULL AS paper_affiliation_name, NULL AS paper_orcid,
      NULL AS paper_doi
    FROM candidates
  `;
}

function buildPaperBase(hasReview) {
  if (hasReview) {
    return `
      SELECT
        pa.id, NULL AS school_rank, NULL AS school_name_en,
        NULL AS department_id, NULL AS department_name_en, NULL AS category,
        'paper' AS source, 'paper_author' AS source_kind,
        pa.affiliation_name AS source_url, NULL AS source_list_url,
        pa.paper_id AS local_path,
        pa.author_name AS name_raw,
        pa.affiliation_name AS title_raw,
        pa.orcid AS email_raw,
        pa.chinese_name_probability, pa.chinese_name_reasons, pa.chinese_name_negatives,
        pa.review_status, pa.review_notes,
        pa.first_seen_at, pa.last_seen_at, 'success' AS crawl_status,
        NULL AS headshot_url, NULL AS headshot_local_path, NULL AS headshot_crawl_status,
        pa.is_target_candidate,
        pa.paper_id, p.title AS paper_title, p.journal_id AS paper_journal_id,
        j.journal_name_en AS paper_journal_name, p.publish_year AS paper_publish_year,
        p.publish_date AS paper_publish_date, pa.author_position AS paper_author_position,
        pa.is_first_author AS paper_is_first_author,
        pa.is_last_author AS paper_is_last_author,
        pa.is_corresponding AS paper_is_corresponding,
        pa.affiliation_name AS paper_affiliation_name, pa.orcid AS paper_orcid,
        p.doi AS paper_doi
      FROM paper_authors pa
      LEFT JOIN papers p ON p.id = pa.paper_id
      LEFT JOIN journals j ON j.id = p.journal_id
    `;
  }
  return `
    SELECT
      pa.id, NULL AS school_rank, NULL AS school_name_en,
      NULL AS department_id, NULL AS department_name_en, NULL AS category,
      'paper' AS source, 'paper_author' AS source_kind,
      pa.affiliation_name AS source_url, NULL AS source_list_url,
      pa.paper_id AS local_path,
      pa.author_name AS name_raw,
      pa.affiliation_name AS title_raw,
      pa.orcid AS email_raw,
      pa.chinese_name_probability, pa.chinese_name_reasons, pa.chinese_name_negatives,
      'pending' AS review_status, NULL AS review_notes,
      pa.first_seen_at, pa.last_seen_at, 'success' AS crawl_status,
      NULL AS headshot_url, NULL AS headshot_local_path, NULL AS headshot_crawl_status,
      pa.is_target_candidate,
      pa.paper_id, p.title AS paper_title, p.journal_id AS paper_journal_id,
      j.journal_name_en AS paper_journal_name, p.publish_year AS paper_publish_year,
      p.publish_date AS paper_publish_date, pa.author_position AS paper_author_position,
      pa.is_first_author AS paper_is_first_author,
      pa.is_last_author AS paper_is_last_author,
      pa.is_corresponding AS paper_is_corresponding,
      pa.affiliation_name AS paper_affiliation_name, pa.orcid AS paper_orcid,
      p.doi AS paper_doi
    FROM paper_authors pa
    LEFT JOIN papers p ON p.id = pa.paper_id
    LEFT JOIN journals j ON j.id = p.journal_id
  `;
}

function getFacultyBase(db) {
  // 探测 candidates 表是否有 chinese_name_negatives（v1.2 之前没有）
  const cols = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name));
  return buildFacultyBase(cols.has('chinese_name_negatives'));
}

function getPaperBase(db) {
  const cols = hasPaperAuthorReviewColumns(db);
  return buildPaperBase(!!cols.review_status);
}

function mapRow(r) {
  if (!r) return null;
  const out = {
    id: `${r.source}:${r.id}`,
    source: r.source,
    name: r.name_raw,
    title: r.title_raw,
    school_rank: r.school_rank,
    school_name_en: r.school_name_en,
    department_id: r.department_id,
    department_name_en: r.department_name_en,
    category: r.category,
    chinese_name_probability: r.chinese_name_probability,
    chinese_name_reasons: safeJson(r.chinese_name_reasons, []),
    chinese_name_negatives: safeJson(r.chinese_name_negatives, []),
    source_url: r.source_url,
    local_path: r.local_path,
    headshot_url: r.headshot_url,
    headshot_local_path: r.headshot_local_path,
    headshot_crawl_status: r.headshot_crawl_status,
    email: r.email_raw,
    review_status: r.review_status || 'pending',
    review_notes: r.review_notes,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    crawl_status: r.crawl_status,
    is_target_candidate: r.is_target_candidate,
  };
  if (r.source === 'paper') {
    out.paper = {
      id: r.paper_id,
      title: r.paper_title,
      journal_id: r.paper_journal_id,
      journal_name: r.paper_journal_name,
      publish_year: r.paper_publish_year,
      publish_date: r.paper_publish_date,
      author_position: r.paper_author_position,
      is_first_author: !!r.paper_is_first_author,
      is_last_author: !!r.paper_is_last_author,
      is_corresponding: !!r.paper_is_corresponding,
      affiliation_name: r.paper_affiliation_name,
      orcid: r.paper_orcid,
      doi: r.paper_doi,
    };
  } else {
    out.paper = null;
  }
  return out;
}

// ─── list / get ─────────────────────────────────────────────

function listCandidates(db, source, rawQuery) {
  const q = normalizeQuery(rawQuery);
  const base = source === 'faculty' ? getFacultyBase(db)
    : source === 'paper' ? getPaperBase(db)
    : null;
  if (!base) throw new Error(`unknown source: ${source}`);

  const { whereSql, params } = buildWhere(q, { source });
  const orderBy = buildOrderBy(q);
  const offset = (q.page - 1) * q.page_size;

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM (${base}) WHERE ${whereSql}`
  ).get(params);
  const rows = db.prepare(
    `SELECT * FROM (${base}) WHERE ${whereSql} ORDER BY ${orderBy} LIMIT @lim OFFSET @off`
  ).all({ ...params, lim: q.page_size, off: offset });

  return { rows: rows.map(mapRow), total: totalRow.n, page: q.page, page_size: q.page_size };
}

function getCandidate(db, source, id) {
  const base = source === 'faculty' ? getFacultyBase(db)
    : source === 'paper' ? getPaperBase(db)
    : null;
  if (!base) return null;
  const row = db.prepare(`SELECT * FROM (${base}) WHERE id = @id LIMIT 1`).get({ id });
  return mapRow(row);
}

// ─── 写回审核 ──────────────────────────────────────────────

function updateFacultyReview(db, id, { review_status, review_notes }) {
  const status = REVIEW_STATUSES.includes(review_status) ? review_status : null;
  if (!status) {
    const e = new Error(`invalid review_status: ${review_status}; allowed: ${REVIEW_STATUSES.join(',')}`);
    e.code = 'EINVAL';
    throw e;
  }
  const result = db.prepare(`
    UPDATE candidates
       SET review_status = @rs,
           review_notes  = @rn,
           last_seen_at  = @ts
     WHERE id = @id
  `).run({ id, rs: status, rn: review_notes ?? null, ts: new Date().toISOString() });
  return { updated: result.changes, status, notes: review_notes ?? null };
}

function updatePaperReview(db, id, { review_status, review_notes }) {
  const cols = hasPaperAuthorReviewColumns(db);
  if (!cols.review_status) {
    return {
      updated: 0, status: review_status, notes: review_notes ?? null, persisted: false,
      reason: 'paper_authors.review_status column missing (waiting on BRA-23)',
    };
  }
  const status = REVIEW_STATUSES.includes(review_status) ? review_status : null;
  if (!status) {
    const e = new Error(`invalid review_status: ${review_status}; allowed: ${REVIEW_STATUSES.join(',')}`);
    e.code = 'EINVAL';
    throw e;
  }
  const result = db.prepare(`
    UPDATE paper_authors
       SET review_status = @rs,
           review_notes  = @rn,
           last_seen_at  = @ts
     WHERE id = @id
  `).run({ id, rs: status, rn: review_notes ?? null, ts: new Date().toISOString() });
  return { updated: result.changes, status, notes: review_notes ?? null, persisted: true };
}

// ─── 维度统计 ─────────────────────────────────────────────

function getFacets(db) {
  const faculty = db.prepare(`
    SELECT school_rank, school_name_en, department_id, department_name_en, category, review_status
    FROM candidates WHERE source_kind = 'personal_page'
  `).all();
  const cols = hasPaperAuthorReviewColumns(db);
  const paperStatusExpr = cols.review_status ? 'pa.review_status' : "'pending' AS review_status";
  const paper = db.prepare(`
    SELECT pa.id, ${paperStatusExpr}, j.school_level AS category
    FROM paper_authors pa
    LEFT JOIN papers p ON p.id = pa.paper_id
    LEFT JOIN journals j ON j.id = p.journal_id
    WHERE pa.is_target_candidate = 1
  `).all();

  const schoolMap = new Map();
  for (const r of faculty) {
    if (!r.school_rank) continue;
    if (!schoolMap.has(r.school_rank)) {
      schoolMap.set(r.school_rank, { rank: r.school_rank, name_en: r.school_name_en, count: 0 });
    }
    schoolMap.get(r.school_rank).count += 1;
  }
  const schools = [...schoolMap.values()].sort((a, b) => a.rank - b.rank);

  const deptMap = new Map();
  for (const r of faculty) {
    if (!r.department_id) continue;
    if (!deptMap.has(r.department_id)) {
      deptMap.set(r.department_id, {
        id: r.department_id,
        name_en: r.department_name_en,
        school_rank: r.school_rank,
        category: r.category,
        count: 0,
      });
    }
    deptMap.get(r.department_id).count += 1;
  }
  const departments = [...deptMap.values()].sort((a, b) => (a.school_rank || 0) - (b.school_rank || 0) || a.id.localeCompare(b.id));

  const catSet = new Map();
  for (const r of faculty) {
    if (!r.category) continue;
    catSet.set(r.category, (catSet.get(r.category) || 0) + 1);
  }
  const categories = [...catSet.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);

  const statusSet = new Map();
  for (const r of faculty) {
    const k = r.review_status || 'pending';
    statusSet.set(k, (statusSet.get(k) || 0) + 1);
  }
  for (const r of paper) {
    const k = r.review_status || 'pending';
    statusSet.set(k, (statusSet.get(k) || 0) + 1);
  }
  const review_status = [...statusSet.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => a.id.localeCompare(b.id));

  return { schools, departments, categories, review_status };
}

function getStats(db) {
  const facTotal = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE source_kind = 'personal_page'").get().n;
  const facChinese = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE source_kind = 'personal_page' AND chinese_name_probability >= 0.4").get().n;
  const paperTotal = db.prepare("SELECT COUNT(*) AS n FROM paper_authors WHERE is_target_candidate = 1").get().n;
  const paperChinese = db.prepare("SELECT COUNT(*) AS n FROM paper_authors WHERE is_target_candidate = 1 AND chinese_name_probability >= 0.4").get().n;
  const facStatus = db.prepare("SELECT review_status, COUNT(*) AS n FROM candidates WHERE source_kind = 'personal_page' GROUP BY review_status").all();
  const cols = hasPaperAuthorReviewColumns(db);
  let paperStatus;
  if (cols.review_status) {
    paperStatus = db.prepare("SELECT COALESCE(review_status, 'pending') AS s, COUNT(*) AS n FROM paper_authors WHERE is_target_candidate = 1 GROUP BY s").all();
  } else {
    paperStatus = [{ s: 'pending', n: paperTotal }];
  }
  return {
    faculty: { total: facTotal, chinese_likely: facChinese, by_status: facStatus },
    paper: { total: paperTotal, chinese_likely: paperChinese, by_status: paperStatus },
    review_status_enum: REVIEW_STATUSES,
  };
}

module.exports = {
  REVIEW_STATUSES,
  openDatabase,
  closeDatabase,
  hasPaperAuthorReviewColumns,
  normalizeQuery,
  listCandidates,
  getCandidate,
  updateFacultyReview,
  updatePaperReview,
  getFacets,
  getStats,
  _internal: { mapRow, buildWhere, buildOrderBy, getFacultyBase, getPaperBase, buildFacultyBase, buildPaperBase },
};
