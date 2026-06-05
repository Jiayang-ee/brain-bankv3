// crossref.js — Crossref API 客户端（无第三方依赖，仅 node:https）。
//
// 文档：https://api.crossref.org/swagger-ui/index.html
//   - Journal: GET /journals/<ISSN>             → 期刊元信息（含 publisher / subject 等）
//   - Works:   GET /works?filter=issn:<ISSN>,from-pub-date:...,until-pub-date:...,type:journal-article
//
// Crossref 的 author 对象：
//   { given, family, sequence ('first'|'additional'), ORCID, affiliation: [{name}] }
// 其中 sequence='first' 标记一作；通讯作者信息 Crossref 不直接提供，约定取每篇 paper 的
// 末位作者（last author）作为潜在的通讯作者（学术界惯例）。
//
// 公开：
//   - createCrossref({ fetchImpl, mailto, rateLimitMs, timeoutMs, retries })
//   - api.findJournal(issn)         → Crossref journal message 对象 或 null
//   - api.iterateWorks({ issn, from, until, type, onPage, maxPages, rows })

'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DEFAULT_BASE = 'https://api.crossref.org';
const DEFAULT_UA = 'brain-bankv3-faculty-crawler/1.0 (+multica; academic-research; +https://github.com/Jiayang-ee/brain-bankv3; mailto:placeholder)';
const MAX_PAGES_HARD = 100;          // Crossref offset 翻页 100 页 × 1000 = 10万 / 刊
const DEFAULT_ROWS = 200;            // Crossref 允许 max=1000，但 200 与 OpenAlex 对齐

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function buildHeaders(mailto) {
  return {
    'User-Agent': mailto ? `${DEFAULT_UA}-${mailto}` : DEFAULT_UA,
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
  return 'error';
}

async function getJson(rawUrl, { fetchImpl, headers, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (fetchImpl) return fetchImpl(rawUrl, { headers, timeoutMs, maxBytes });
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
        if (res.statusCode === 404) {
          return resolve({ ok: false, error: 'http_error', status: 404, errorDetail: 'not_found' });
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
    if (r.error === 'http_error' && r.status && r.status >= 400 && r.status < 500) return r;
    last = r;
    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  return last;
}

function buildAuthorName(author) {
  if (!author) return null;
  if (author.name) return author.name;
  const parts = [];
  if (author.given) parts.push(author.given);
  if (author.family) parts.push(author.family);
  return parts.length ? parts.join(' ').trim() : null;
}

function createCrossref({
  fetchImpl = null,
  mailto = process.env.OPENALEX_MAILTO || null,
  rateLimitMs = 1500,
  timeoutMs = 15000,
  retries = 2,
} = {}) {
  let lastHit = 0;
  async function pace() {
    const now = Date.now();
    const wait = lastHit + rateLimitMs - now;
    if (wait > 0) await sleep(wait);
    lastHit = Date.now();
  }

  async function findJournal(issn) {
    if (!issn) return null;
    const clean = String(issn).replace(/[\s-]/g, '').toUpperCase();
    if (clean.length !== 8) return null;
    const url = `${DEFAULT_BASE}/journals/${clean}`;
    await pace();
    const r = await getJsonWithRetry(url, { fetchImpl, timeoutMs, retries });
    if (!r.ok) return { _error: r };
    return (r.data && r.data.message) || null;
  }

  function normalizeWork(item) {
    if (!item) return null;
    const title = Array.isArray(item.title) && item.title.length ? item.title[0] : null;
    const published = item.published || item['published-print'] || item['published-online'] || item.issued || {};
    const dateParts = (published['date-parts'] && published['date-parts'][0]) || [];
    const year = dateParts[0] || null;
    const month = dateParts[1] || null;
    const day = dateParts[2] || null;
    const publishDate = year ? `${year}-${String(month || '01').padStart(2, '0')}-${String(day || '01').padStart(2, '0')}` : null;
    const authorships = Array.isArray(item.author) ? item.author : [];
    const total = authorships.length;
    return {
      id: item.URL || null,
      doi: (item.DOI || '').toLowerCase() || null,
      title: (title || '').trim() || '(untitled)',
      publish_year: year,
      publish_date: publishDate,
      language: item.language || null,
      type: item.type || null,
      cited_by_count: item['is-referenced-by-count'] || 0,
      issn_l: Array.isArray(item.ISSN) ? item.ISSN[0] : null,
      source_id: null,
      source_name: Array.isArray(item['container-title']) && item['container-title'].length
        ? item['container-title'][0] : null,
      volume: item.volume || null,
      issue: item.issue || null,
      page_first: item.page ? String(item.page).split('-')[0] : null,
      page_last: item.page && String(item.page).includes('-') ? String(item.page).split('-')[1] : null,
      authorships: authorships.map((a, idx) => {
        const name = buildAuthorName(a);
        const seq = (a && a.sequence) || 'additional';
        const isFirst = seq === 'first';
        // Crossref 不直接给通讯作者；约定：取末位作者作为潜在通讯作者
        const isLast = idx === total - 1;
        return {
          name,
          position: idx,
          is_first_author: isFirst,
          is_last_author: isLast,
          is_corresponding: isLast,           // 启发式：末位 = 通讯
          affiliation_raw: a && a.affiliation && a.affiliation.length
            ? a.affiliation[0].name || null : null,
          affiliation_id: null,
          affiliation_name: a && a.affiliation && a.affiliation.length
            ? a.affiliation[0].name || null : null,
          orcid: a && a.ORCID ? String(a.ORCID).replace(/^https?:\/\/orcid\.org\//i, '').toLowerCase() : null,
        };
      }),
    };
  }

  async function iterateWorks({
    issn,
    from = '2021-01-01',
    until = '2026-06-03',
    type = 'journal-article',
    onPage = null,
    maxPages = MAX_PAGES_HARD,
    rows = DEFAULT_ROWS,
  }) {
    if (!issn) return { ok: false, error: 'missing_issn', errorDetail: 'issn required' };
    const filterParts = [`issn:${issn}`, `from-pub-date:${from}`, `until-pub-date:${until}`];
    if (type) filterParts.push(`type:${type}`);
    const filter = encodeURIComponent(filterParts.join(','));
    let offset = 0;
    let pages = 0;
    let total = 0;
    while (pages < maxPages) {
      const url = `${DEFAULT_BASE}/works?filter=${filter}&rows=${rows}&offset=${offset}`;
      await pace();
      const r = await getJsonWithRetry(url, { fetchImpl, timeoutMs, retries });
      if (!r.ok) {
        return { ok: false, pages, total, error: r.error, errorDetail: r.errorDetail, status: r.status };
      }
      const data = r.data || {};
      const items = (data.message && data.message.items) || [];
      pages += 1;
      total += items.length;
      if (typeof onPage === 'function') {
        try {
          await onPage({ page: pages, results: items, raw: data });
        } catch (err) {
          return { ok: false, pages, total, error: 'callback_error', errorDetail: err.message };
        }
      }
      const totalResults = (data.message && data.message['total-results']) || 0;
      if (items.length === 0 || offset + items.length >= totalResults) break;
      offset += items.length;
    }
    return { ok: true, pages, total };
  }

  return {
    findJournal,
    iterateWorks,
    normalizeWork,
    getJsonWithRetry,
  };
}

module.exports = {
  createCrossref,
  DEFAULT_BASE,
};
