// crossref_email.js — Crossref /works/{doi} 节点邮箱抽取（BRA-9.3 3a spike）。
//
// 思路：
//   1. 取 Crossref `/works/{doi}` 响应（与现有 lib/crossref.js 共用 fetch + 限速）
//   2. 抽 author[].affiliation[].name（部分 publisher 把邮箱塞 affiliation 字符串里）
//   3. 抽 author[].role[]（少数 publisher 在 role 节点塞邮箱）
//   4. 抽 assertion[]（极少数 publisher 在 assertion 节点塞 corresponding author email）
//   5. 抽 license[].URL（极罕见，license 邮箱注册）
//   6. RFC5322 简化正则 + 黑名单域 + 长度上限（与 email_extract.js 对齐）
//
// 合规：
//   - 匿名 GET https://api.crossref.org/works/{doi}（无 OAuth）
//   - 限速：Crossref 公共 50 req/sec（公平使用降到 20）
//   - 仅入 DB；不发任何 outreach 邮件
//
// 公开：
//   - createCrossrefEmail({ fetchImpl, logger, rateLimitMs, timeoutMs, userAgent })
//   - api.extractEmailsFromWork(workJson)     → [{ email, source_field, author_idx }] | []
//   - api.fetchWork(doi)                      → { ok, status, work, error, errorDetail }
//   - api.processWork({ doi, fetchImpl })     → { doi, emails, _ok, _status, _error, _durationMs }
//
// 设计要点（与 Crossref 公共 API 行为对齐）：
//   - 200 + application/json  → 正常解析
//   - 404 → doi 不存在（沉默返回，不重试）
//   - 429 → 限速触发；指数退避 1s/2s/4s 最多 3 次
//   - 5xx → 临时错误；指数退避 1s/2s/4s 最多 3 次
//   - 4xx (除 429) → 永久错误；不重试
//   - 网络错误（ETIMEDOUT/ENOTFOUND/...）→ 退避重试

'use strict';

const https = require('node:https');
const { URL } = require('node:url');
const zlib = require('node:zlib');

// Crossref 公共 API 限速：50 req/sec，公平使用降到 20
const DEFAULT_RATE_LIMIT_MS = 50;          // 1 / 0.05s = 20 req/sec
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE = 'https://api.crossref.org';
const DEFAULT_USER_AGENT = 'brain-bank/0.1 (mailto:agent@multica.ai)';

// 与 email_extract.js / orcid_enrich.js 复用：RFC5322 简化
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;

const REJECTED_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'example.edu',
  'test.com', 'test.org', 'test.edu',
  'noreply.com', 'no-reply.com', 'noreply.org', 'noreply.edu',
  'localhost', 'localhost.localdomain',
  'email.com', 'yourcompany.com', 'yourdomain.com',
  'springer.com', 'springeropen.com', 'nature.com',  // publisher 自身
  'elsevier.com', 'wiley.com', 'ieee.org', 'acm.org',
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createRateLimiter(minIntervalMs) {
  const lastHit = new Map();
  return async function limit(host) {
    const now = Date.now();
    const last = lastHit.get(host) || 0;
    const wait = last + minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  };
}

function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  EMAIL_RE.lastIndex = 0;
  const m = email.match(EMAIL_RE);
  if (!m) return false;
  return m[0] === email;
}

function isBlacklistedDomain(email) {
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  return REJECTED_DOMAINS.includes(domain);
}

function normalizeDoi(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  s = s.replace(/^https?:\/\/(?:www\.)?(?:dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:/i, '');
  s = s.toLowerCase();
  // 简单 doi 形如 10.NNNN/...
  if (/^10\.\d{4,9}\/\S+$/i.test(s)) return s;
  return null;
}

// 从 string 字段里抽邮箱（去重 + 校验 + 黑名单）
function extractEmailsFromString(text, sourceField) {
  if (!text || typeof text !== 'string') return [];
  EMAIL_RE.lastIndex = 0;
  const matches = text.match(EMAIL_RE) || [];
  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    const e = raw.toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e);
    if (!isValidEmailFormat(raw)) continue;
    if (isBlacklistedDomain(raw)) continue;
    out.push({ email: raw, source_field: sourceField });
  }
  return out;
}

function extractEmailsFromAffiliation(aff, authorIdx, sourceField) {
  if (!aff || typeof aff !== 'object') return [];
  const out = [];
  if (aff.name) {
    for (const e of extractEmailsFromString(aff.name, sourceField)) {
      out.push({ ...e, author_idx: authorIdx });
    }
  }
  return out;
}

function extractEmailsFromAssertion(assertion, sourceField = 'assertion') {
  if (!assertion) return [];
  const list = Array.isArray(assertion) ? assertion : [assertion];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    if (a.value) {
      for (const e of extractEmailsFromString(String(a.value), sourceField)) {
        out.push(e);
      }
    }
    if (a.name && typeof a.name === 'string') {
      for (const e of extractEmailsFromString(a.name, sourceField)) {
        out.push(e);
      }
    }
  }
  return out;
}

function extractEmailsFromWork(workJson) {
  if (!workJson || typeof workJson !== 'object') return [];
  const out = [];
  const seen = new Set();
  const push = (hits) => {
    for (const h of hits) {
      const key = `${h.email}|${h.source_field || ''}|${h.author_idx ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  };

  // author[].affiliation[].name（最常见的塞邮箱位置）
  if (Array.isArray(workJson.author)) {
    workJson.author.forEach((a, idx) => {
      if (a && Array.isArray(a.affiliation)) {
        a.affiliation.forEach((aff) => {
          push(extractEmailsFromAffiliation(aff, idx, 'author_affiliation_name'));
        });
      }
      // author[].name 字段（极少见）
      if (a && a.name) {
        push(extractEmailsFromString(a.name, 'author_name').map((e) => ({ ...e, author_idx: idx })));
      }
      // author[].role[].role 字符串
      if (a && Array.isArray(a.role)) {
        a.role.forEach((r) => {
          if (r && r.role) push(extractEmailsFromString(r.role, 'author_role'));
        });
      }
    });
  }

  // assertion[]
  push(extractEmailsFromAssertion(workJson.assertion, 'assertion'));

  // license[].URL（license 邮箱注册，罕见）
  if (Array.isArray(workJson.license)) {
    workJson.license.forEach((lic) => {
      if (lic && lic.URL) push(extractEmailsFromString(lic.URL, 'license_url'));
    });
  }

  return out;
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

function classifyError(code, message) {
  if (code === 'ENOTFOUND') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
  if (message && /timeout/i.test(message)) return 'timeout';
  return 'error';
}

function getJsonOnce(rawUrl, { fetchImpl, headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 4 * 1024 * 1024 } = {}) {
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
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(headers || {}),
      },
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
        if (truncated) return resolve({ ok: false, status: res.statusCode, error: 'too_large', errorDetail: `> ${maxBytes} bytes` });
        const raw = Buffer.concat(chunks);
        const decoded = decodeBody(raw, res.headers['content-encoding']);
        const body = decoded.toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let data = null;
          try { data = body ? JSON.parse(body) : null; } catch (err) {
            return resolve({ ok: false, status: res.statusCode, error: 'parse_error', errorDetail: err.message });
          }
          return resolve({ ok: true, status: res.statusCode, data });
        }
        if (res.statusCode === 404) {
          return resolve({ ok: false, status: 404, error: 'not_found', errorDetail: 'DOI not found' });
        }
        if (res.statusCode === 429) {
          return resolve({ ok: false, status: 429, error: 'rate_limited', errorDetail: res.headers['retry-after'] || 'no Retry-After' });
        }
        return resolve({
          ok: false,
          status: res.statusCode,
          error: res.statusCode >= 500 ? 'http_5xx' : 'http_4xx',
          errorDetail: body ? body.slice(0, 200) : `HTTP ${res.statusCode}`,
        });
      });
      res.on('error', (err) => resolve({ ok: false, error: classifyError(err && err.code, err && err.message), errorDetail: err.message }));
    });
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error('socket timeout')); } catch (_) {}
    });
    req.on('error', (err) => resolve({ ok: false, error: classifyError(err && err.code, err && err.message), errorDetail: err.message }));
    req.end();
  });
}

function createCrossrefEmail({
  fetchImpl = null,
  logger = console,
  rateLimitMs = DEFAULT_RATE_LIMIT_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  userAgent = DEFAULT_USER_AGENT,
  base = DEFAULT_BASE,
} = {}) {
  const rateLimit = createRateLimiter(rateLimitMs);
  const headers = {
    'User-Agent': userAgent,
    Accept: 'application/json',
  };

  async function fetchWork(rawDoi) {
    const doi = normalizeDoi(rawDoi);
    if (!doi) return { ok: false, status: 0, error: 'invalid_doi', errorDetail: String(rawDoi) };
    const url = `${base}/works/${encodeURIComponent(doi)}`;
    let last = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await rateLimit(new URL(url).hostname);
      const r = await getJsonOnce(url, { fetchImpl, headers, timeoutMs });
      if (r.ok) {
        const work = r.data && r.data.message;
        return { ok: true, status: r.status, work, doi };
      }
      last = r;
      if (r.status === 404 || (r.status && r.status >= 400 && r.status < 500 && r.status !== 429)) {
        return { ok: false, status: r.status || 0, work: null, error: r.error, errorDetail: r.errorDetail };
      }
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn?.(`[crossref-email] ${doi} attempt=${attempt} failed (${r.error}); retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
    return {
      ok: false,
      status: last?.status || 0,
      work: null,
      error: last?.error || 'error',
      errorDetail: last?.errorDetail || 'exhausted retries',
      attempts: (last?.attempt ?? 0) + 1,
    };
  }

  async function processWork({ doi }) {
    const t0 = Date.now();
    const r = await fetchWork(doi);
    if (!r.ok || !r.work) {
      return {
        doi: normalizeDoi(doi),
        emails: [],
        _ok: false,
        _status: r.status,
        _error: r.error,
        _errorDetail: r.errorDetail,
        _durationMs: Date.now() - t0,
      };
    }
    const hits = extractEmailsFromWork(r.work);
    return {
      doi: normalizeDoi(doi),
      emails: hits,
      _ok: true,
      _status: r.status,
      _emailsCount: hits.length,
      _durationMs: Date.now() - t0,
    };
  }

  return {
    normalizeDoi,
    isValidEmailFormat,
    isBlacklistedDomain,
    extractEmailsFromString,
    extractEmailsFromAffiliation,
    extractEmailsFromAssertion,
    extractEmailsFromWork,
    fetchWork,
    processWork,
    headers,
    rateLimitMs,
    timeoutMs,
    userAgent,
    base,
  };
}

module.exports = {
  createCrossrefEmail,
  normalizeDoi,
  isValidEmailFormat,
  isBlacklistedDomain,
  extractEmailsFromString,
  extractEmailsFromAffiliation,
  extractEmailsFromAssertion,
  extractEmailsFromWork,
  REJECTED_DOMAINS,
  DEFAULT_BASE,
  DEFAULT_USER_AGENT,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
