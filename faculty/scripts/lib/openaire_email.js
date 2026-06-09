// openaire_email.js — OpenAIRE /search/researchProducts 节点邮箱抽取（BRA-9.3 3a spike）。
//
// 思路：
//   1. 取 OpenAIRE `https://api.openaire.eu/search/researchProducts?doi={doi}&format=json`
//   2. 抽 creator / contact 节点邮箱（OpenAIRE schema 用 OAI-PMH 1.x）
//   3. 抽 /oaf:entity/oaf:result/creator/@email 或 $ 字符串
//   4. RFC5322 简化正则 + 黑名单域 + 长度上限（与 email_extract.js 对齐）
//
// 合规：
//   - 匿名 GET https://api.openaire.eu/search/researchProducts
//   - 限速：OpenAIRE 公共 10 req/sec（公平使用降到 5）
//   - 仅入 DB；不发任何 outreach 邮件
//
// 公开：
//   - createOpenaireEmail({ fetchImpl, logger, rateLimitMs, timeoutMs, userAgent })
//   - api.extractEmailsFromResponse(jsonOrXmlText)  → [{ email, source_field, creator_idx }]
//   - api.fetchByDoi(doi)                           → { ok, status, data, error, errorDetail }
//   - api.processDoi({ doi })                       → { doi, emails, _ok, _status, _error, _durationMs }

'use strict';

const https = require('node:https');
const { URL } = require('node:url');
const zlib = require('node:zlib');

const DEFAULT_RATE_LIMIT_MS = 200;         // 5 req/sec
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE = 'https://api.openaire.eu';
const DEFAULT_USER_AGENT = 'brain-bank/0.1 (mailto:agent@multica.ai)';
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;

const REJECTED_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'example.edu',
  'test.com', 'test.org', 'test.edu',
  'noreply.com', 'no-reply.com', 'noreply.org', 'noreply.edu',
  'localhost', 'localhost.localdomain',
  'email.com', 'yourcompany.com', 'yourdomain.com',
  'openaire.eu',
  // BRA-9.3 1,000 spike 跑出来的噪声：用户填的「平台邮箱」而非机构邮箱
  'github.com', 'gitlab.com', 'bitbucket.org',
  'academia.edu', 'researchgate.net', 'linkedin.com',
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
  if (/^10\.\d{4,9}\/\S+$/i.test(s)) return s;
  return null;
}

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

// 遍历任意 JSON 节点抽取字符串字段里的邮箱
function walkJson(node, sourceField, accumulator, depth = 0) {
  if (depth > 50) return;  // 防止病态递归
  if (node == null) return;
  if (typeof node === 'string') {
    for (const e of extractEmailsFromString(node, sourceField)) {
      const key = `${e.email}|${sourceField}`;
      if (!accumulator.seen.has(key)) {
        accumulator.seen.add(key);
        accumulator.list.push(e);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkJson(v, sourceField, accumulator, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // 邮箱可能在 key='email'/'mail'/'contact' 节点
      const lower = k.toLowerCase();
      const isEmailKey = lower === 'email' || lower === 'mail' || lower === 'e-mail' || lower === 'contact' || lower.endsWith('email') || lower.endsWith('mail');
      if (isEmailKey) {
        walkJson(v, `field:${k}`, accumulator, depth + 1);
      } else {
        walkJson(v, sourceField, accumulator, depth + 1);
      }
    }
  }
}

function extractEmailsFromJson(json) {
  if (!json || typeof json !== 'object') return [];
  const accumulator = { list: [], seen: new Set() };
  // 重点关注 oaf:entity/oaf:result/creator 和 contact 节点
  walkJson(json, 'openaire', accumulator);
  return accumulator.list;
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

function getJsonOnce(rawUrl, { fetchImpl, headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 8 * 1024 * 1024 } = {}) {
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

function createOpenaireEmail({
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

  async function fetchByDoi(rawDoi) {
    const doi = normalizeDoi(rawDoi);
    if (!doi) return { ok: false, status: 0, error: 'invalid_doi', errorDetail: String(rawDoi) };
    const url = `${base}/search/researchProducts?doi=${encodeURIComponent(doi)}&format=json`;
    let last = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await rateLimit(new URL(url).hostname);
      const r = await getJsonOnce(url, { fetchImpl, headers, timeoutMs });
      if (r.ok) return { ok: true, status: r.status, data: r.data, doi };
      last = r;
      if (r.status === 404 || (r.status && r.status >= 400 && r.status < 500 && r.status !== 429)) {
        return { ok: false, status: r.status || 0, data: null, error: r.error, errorDetail: r.errorDetail };
      }
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn?.(`[openaire-email] ${doi} attempt=${attempt} failed (${r.error}); retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
    return {
      ok: false,
      status: last?.status || 0,
      data: null,
      error: last?.error || 'error',
      errorDetail: last?.errorDetail || 'exhausted retries',
      attempts: (last?.attempt ?? 0) + 1,
    };
  }

  async function processDoi({ doi }) {
    const t0 = Date.now();
    const r = await fetchByDoi(doi);
    if (!r.ok || !r.data) {
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
    const hits = extractEmailsFromJson(r.data);
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
    extractEmailsFromJson,
    fetchByDoi,
    processDoi,
    headers,
    rateLimitMs,
    timeoutMs,
    userAgent,
    base,
  };
}

module.exports = {
  createOpenaireEmail,
  normalizeDoi,
  isValidEmailFormat,
  isBlacklistedDomain,
  extractEmailsFromString,
  extractEmailsFromJson,
  REJECTED_DOMAINS,
  DEFAULT_BASE,
  DEFAULT_USER_AGENT,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
