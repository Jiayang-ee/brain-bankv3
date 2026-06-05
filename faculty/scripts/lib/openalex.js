// openalex.js — OpenAlex API 客户端（无第三方依赖，仅 node:https）。
//
// 文档：https://docs.openalex.org/
//   - Sources: GET /sources?filter=issn:XXXX-XXXX|issn_l:XXXXXXXX
//   - Works:   GET /works?filter=primary_location.source.id:S...,from_publication_date:...,until_publication_date:...,type:article
//
// 礼貌使用：
//   - 必须带 User-Agent（OpenAlex 的"polite pool"用 mailto 识别，免费无限流量）
//   - 默认 User-Agent 标注本项目身份 + 联系邮箱（来自 OPENALEX_MAILTO 环境变量）
//   - 默认 1.5s host 限速 + 15s 单次超时 + 2 次指数退避重试
//
// 公开：
//   - createOpenAlex({ fetchImpl, mailto, logger, rateLimitMs, timeoutMs, retries })
//   - api.findSourceByIssn(issn)         → source 对象 或 null
//   - api.findSourceByName(name, issn)   → source 对象 或 null
//   - api.iterateWorks({ sourceId, from, until, type, onPage, maxPages, perPage })
//
// 错误约定：函数不抛异常，统一返回 { ok, status, data, error, errorDetail }。

'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DEFAULT_BASE = 'https://api.openalex.org';
const DEFAULT_UA = 'brain-bankv3-faculty-crawler/1.0 (+multica; academic-research; +https://github.com/Jiayang-ee/brain-bankv3)';
const MAX_PAGES_HARD = 200;            // 安全网：单刊最多 200 页 × 200 = 40000 篇
const DEFAULT_PER_PAGE = 200;          // OpenAlex 文档允许 max=200

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function buildHeaders(mailto) {
  const ua = mailto
    ? `${DEFAULT_UA} (mailto:${mailto})`
    : DEFAULT_UA;
  return {
    'User-Agent': ua,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br',
  };
}

function decodeBody(raw, encoding) {
  if (!raw) return Buffer.alloc(0);
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(raw);
    if (enc === 'deflate') return zlib.inflateSync(raw);
    if (enc === 'br') return zlib.brotliDecompressSync(raw);
  } catch (_) { /* ignore */ }
  return raw;
}

function classifyError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
  if (err && /timeout/i.test(err.message || '')) return 'timeout';
  return 'error';
}

// 简易 GET + JSON 解析。可注入 fetchImpl 用于 dry-run / 单元测试。
async function getJson(rawUrl, { fetchImpl, headers, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (fetchImpl) {
    return fetchImpl(rawUrl, { headers, timeoutMs, maxBytes });
  }
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch (err) {
      resolve({ ok: false, error: 'invalid_url', errorDetail: err.message });
      return;
    }
    const req = https.request({
      method: 'GET',
      host: url.hostname,
      port: url.port || 443,
      path: `${url.pathname || '/'}${url.search || ''}`,
      headers: { ...buildHeaders(), ...(headers || {}) },
    }, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on('data', (chunk) => {
        if (truncated) return;
        total += chunk.length;
        if (total > maxBytes) {
          truncated = true;
          try { res.destroy(); } catch (_) {}
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (truncated) return resolve({ ok: false, error: 'too_large', errorDetail: `> ${maxBytes} bytes` });
        const rawBuf = Buffer.concat(chunks);
        const decoded = decodeBody(rawBuf, res.headers['content-encoding']);
        const raw = decoded.toString('utf8');
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve({ ok: false, error: 'redirect', status: res.statusCode, redirectedTo: res.headers.location });
        }
        if (res.statusCode >= 400) {
          return resolve({ ok: false, error: 'http_error', status: res.statusCode, errorDetail: raw.slice(0, 500) });
        }
        try {
          return resolve({ ok: true, status: res.statusCode, data: JSON.parse(raw) });
        } catch (err) {
          return resolve({ ok: false, error: 'parse_error', errorDetail: err.message });
        }
      });
      res.on('error', (err) => resolve({ ok: false, error: classifyError(err), errorDetail: err.message }));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('socket timeout')); } catch (_) {} });
    req.on('error', (err) => resolve({ ok: false, error: classifyError(err), errorDetail: err.message }));
    req.end();
  });
}

async function getJsonWithRetry(rawUrl, opts = {}) {
  const { retries = 2, baseDelayMs = 500, fetchImpl, headers, timeoutMs, maxBytes } = opts;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const r = await getJson(rawUrl, { fetchImpl, headers, timeoutMs, maxBytes });
    if (r.ok) return r;
    if (r.error === 'http_error' && r.status && r.status >= 400 && r.status < 500) return r; // 4xx 不重试
    last = r;
    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  return last;
}

// OpenAlex Works meta 字段的精简选择：减少响应体大小
// 选：id, doi, title, publication_year, publication_date, language,
// primary_location (with source 摘要), authorships (display_name, position, is_corresponding, raw_affiliation_string, institutions),
// type, cited_by_count, biblio (volume, issue, first_page, last_page)
const WORK_SELECT = [
  'id', 'doi', 'title',
  'publication_year', 'publication_date', 'language',
  'type', 'cited_by_count',
  'primary_location',
  'biblio',
  'authorships',
].join(',');

const SOURCE_SELECT = [
  'id', 'issn_l', 'issn', 'display_name', 'host_organization_name', 'type',
  'works_count', 'cited_by_count',
].join(',');

function createOpenAlex({
  fetchImpl = null,
  mailto = process.env.OPENALEX_MAILTO || null,
  rateLimitMs = 1500,
  timeoutMs = 15000,
  retries = 2,
  logger = null,
} = {}) {
  const log = logger || (() => {});
  let lastHit = 0;

  async function pace() {
    const now = Date.now();
    const wait = lastHit + rateLimitMs - now;
    if (wait > 0) await sleep(wait);
    lastHit = Date.now();
  }

  function uaHeader() {
    return mailto ? { 'User-Agent': `${DEFAULT_UA} (mailto:${mailto})` } : {};
  }

  async function findSourceByIssn(issn) {
    if (!issn) return null;
    const issnClean = String(issn).replace(/[\s-]/g, '').toUpperCase();
    if (issnClean.length !== 8) return null;
    // OpenAlex 的 sources 端点要求带连字符的 ISSN，否则命中为 0
    const issnHyphen = `${issnClean.slice(0, 4)}-${issnClean.slice(4)}`;
    // 同时尝试 issn_l 和 issn 两个过滤器，取首个有命中的
    const tries = [
      `${DEFAULT_BASE}/sources?filter=${encodeURIComponent('issn:' + issnHyphen)}&select=${SOURCE_SELECT}&per-page=1`,
      `${DEFAULT_BASE}/sources?filter=${encodeURIComponent('issn_l:' + issnHyphen)}&select=${SOURCE_SELECT}&per-page=1`,
    ];
    await pace();
    for (const url of tries) {
      const r = await getJsonWithRetry(url, { fetchImpl, headers: uaHeader(), timeoutMs, retries });
      if (!r.ok) return { _error: r };
      const results = (r.data && r.data.results) || [];
      if (results.length > 0) {
        const src = results[0];
        return {
          id: src.id,
          issn_l: src.issn_l || issnClean,
          issn_print: Array.isArray(src.issn) ? src.issn[0] : null,
          issn_electronic: Array.isArray(src.issn) ? src.issn[1] || null : null,
          display_name: src.display_name,
          type: src.type,
          works_count: src.works_count,
          cited_by_count: src.cited_by_count,
        };
      }
    }
    return null;
  }

  // 按 name 模糊搜索（兜底用，准确性低）
  async function findSourceByName(name) {
    if (!name) return null;
    const q = encodeURIComponent(name);
    const url = `${DEFAULT_BASE}/sources?search=${q}&select=${SOURCE_SELECT}&per-page=3`;
    await pace();
    const r = await getJsonWithRetry(url, { fetchImpl, headers: uaHeader(), timeoutMs, retries });
    if (!r.ok) return { _error: r };
    const results = (r.data && r.data.results) || [];
    if (results.length === 0) return null;
    // 简单去歧义：完全包含或被包含时取第一个；否则返回第一个
    const lower = name.toLowerCase();
    let best = null;
    for (const s of results) {
      const dn = (s.display_name || '').toLowerCase();
      if (dn === lower) { best = s; break; }
    }
    if (!best) best = results[0];
    return {
      id: best.id,
      issn_l: best.issn_l || null,
      issn_print: Array.isArray(best.issn) ? best.issn[0] || null : null,
      issn_electronic: Array.isArray(best.issn) ? best.issn[1] || null : null,
      display_name: best.display_name,
      type: best.type,
      works_count: best.works_count,
      cited_by_count: best.cited_by_count,
    };
  }

  // 把 OpenAlex 原始 Work 转成管线友好的 normalized 形态
  function normalizeWork(work) {
    if (!work) return null;
    const primary = work.primary_location || {};
    const src = primary.source || {};
    const biblio = work.biblio || {};
    return {
      id: work.id || null,
      doi: (work.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() || null,
      title: (work.title || '').trim() || '(untitled)',
      publish_year: work.publication_year || null,
      publish_date: work.publication_date || null,
      language: work.language || null,
      type: work.type || null,
      cited_by_count: work.cited_by_count || 0,
      issn_l: src.issn_l || null,
      source_id: src.id || null,
      source_name: src.display_name || null,
      volume: biblio.volume || null,
      issue: biblio.issue || null,
      page_first: biblio.first_page || null,
      page_last: biblio.last_page || null,
      authorships: Array.isArray(work.authorships) ? work.authorships : [],
    };
  }

  // 翻页拉取 source 的所有 paper。每次 page 拿到就回调 onPage。
  // 返回 { ok, pages, total, error, errorDetail }。
  async function iterateWorks({
    sourceId,
    from = '2021-01-01',
    until = '2026-06-03',
    type = 'article',
    onPage = null,
    maxPages = MAX_PAGES_HARD,
    perPage = DEFAULT_PER_PAGE,
  }) {
    if (!sourceId) return { ok: false, error: 'missing_source_id', errorDetail: 'sourceId required' };
    const filterParts = [
      `primary_location.source.id:${sourceId}`,
      `from_publication_date:${from}`,
      `to_publication_date:${until}`,
    ];
    if (type) filterParts.push(`type:${type}`);
    const filter = encodeURIComponent(filterParts.join(','));
    let cursor = '*';
    let pages = 0;
    let total = 0;
    while (pages < maxPages) {
      const url = `${DEFAULT_BASE}/works?filter=${filter}&select=${WORK_SELECT}&per-page=${perPage}&cursor=${cursor}`;
      await pace();
      const r = await getJsonWithRetry(url, { fetchImpl, headers: uaHeader(), timeoutMs, retries });
      if (!r.ok) {
        return { ok: false, pages, total, error: r.error, errorDetail: r.errorDetail, status: r.status };
      }
      const data = r.data || {};
      const results = Array.isArray(data.results) ? data.results : [];
      pages += 1;
      total += results.length;
      if (typeof onPage === 'function') {
        try {
          await onPage({ page: pages, results, raw: data });
        } catch (err) {
          return { ok: false, pages, total, error: 'callback_error', errorDetail: err.message };
        }
      }
      const next = data.meta && data.meta.next_cursor;
      if (!next || results.length === 0) break;
      cursor = next;
    }
    return { ok: true, pages, total };
  }

  return {
    findSourceByIssn,
    findSourceByName,
    iterateWorks,
    normalizeWork,
    // 暴露给测试 / 复用
    getJsonWithRetry,
  };
}

module.exports = {
  createOpenAlex,
  WORK_SELECT,
  SOURCE_SELECT,
  DEFAULT_BASE,
};
