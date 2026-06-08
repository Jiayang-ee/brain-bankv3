// orcid_enrich.js — ORCID 公共 API 反向查询补全 author email + profile（BRA-9.2 spike）。
//
// 思路：
//   1. paper_authors 已有 orcid 字段（83.4% 填充率，BRA-9 OpenAlex 落库产物）
//   2. 用 orcid 字段作 lookup key，匿名访问 https://pub.orcid.org/v3.0/{id}/person
//   3. /person 端点返回：name / other-names / external-identifiers / emails / research-url / ...
//      其中 /person/emails 是邮箱的权威来源（用户自己在 ORCID profile 上设的"已知邮箱"）
//   4. 5 req/sec（ORCID anonymous 限速 6 req/sec/IP，保守降到 5）
//   5. 命中后写 paper_authors.email_raw / email_source='orcid_public_api' / email_orcid_id / 6 个 ORCID profile 列
//
// 合规：
//   - 仅 /read-public scope（匿名 GET，无 OAuth）
//   - 不调用任何写端点（无 /person POST/PUT/DELETE）
//   - 不发 outreach 邮件（仅入 DB）
//   - User-Agent 必须带 mailto（ORCID 鼓励但非强制）
//
// 公开：
//   - createOrcidEnrich({ fetchImpl, logger, rateLimitMs, timeoutMs, userAgent })
//   - api.normalizeOrcidId(s)         → '0000-0000-0000-0000' 形式
//   - api.extractEmailFromPerson(personJson)
//                                     → [{ email, primary, visibility }] | []
//   - api.extractExternalIds(personJson)
//                                     → [{ type, value, relationship, url }] | []
//   - api.extractAffiliations(personJson)
//                                     → [{ department, role, org, start, end, city, country }] | []
//   - api.extractCreditName(personJson)
//                                     → string | null
//   - api.unwrapField(node)           → string | null
//                                     （ORCID v3 /person 字段归一：裸字符串 OR {value: ...} 都吃）
//   - api.fetchPerson(orcidId)        → { ok, status, person, lastModified, error, errorDetail }
//   - api.processAuthor({ id, orcid, fetchImpl })
//                                     → record-ready object { emailOrcidId, emailRaw, emailSource, orcidCreditName, ... }
//
// 设计要点（与 ORCID 公共 API 行为对齐）：
//   - 200 + application/json  → 正常解析
//   - 404 → orcid 不存在（沉默返回，不重试）
//   - 429 → 限速触发；指数退避 1s/2s/4s 最多 3 次
//   - 5xx → 临时错误；指数退避 1s/2s/4s 最多 3 次
//   - 4xx (除 429) → 永久错误；不重试
//   - 网络错误（ETIMEDOUT/ENOTFOUND/...）→ 退避重试

'use strict';

const https = require('node:https');
const { URL } = require('node:url');

// ORCID 公共 API 限速：6 req/sec/IP，保守降到 5
const DEFAULT_RATE_LIMIT_MS = 200;        // 1 / 0.2s = 5 req/sec
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE = 'https://pub.orcid.org';
const DEFAULT_USER_AGENT = 'brain-bank/0.1 (mailto:agent@multica.ai)';

// ORCID iD 规范：0000-0000-0000-0000，最后一位允许 0-9 或 X
const ORCID_RE = /^(\d{4}-){3}[\dX]{4}$/;

// 同 email_extract.js 复用：简单 RFC5322 简化
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// 简易 host-level 限速器：与 fetch.js 的 createRateLimiter 同形；
// ORCID 只对单一 host (pub.orcid.org) 限速，所以一个 Map 槽位即可
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

function normalizeOrcidId(input) {
  if (!input || typeof input !== 'string') return null;
  // 去除 URI 前缀、URL 形式
  let s = input.trim();
  s = s.replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '');
  s = s.replace(/^orcid:/i, '');
  s = s.replace(/[\s-]+/g, '-');        // 容错：把空格/多余短横线归一
  s = s.toUpperCase();
  if (ORCID_RE.test(s)) return s;
  // 尝试补齐（输入可能是 16 位纯数字）
  const digits = s.replace(/[^0-9X]/gi, '');
  if (digits.length === 16) {
    const candidate = `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}`;
    if (ORCID_RE.test(candidate)) return candidate;
  }
  return null;
}

function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  // 重置 lastIndex（模块级 regex /g 标志）
  EMAIL_RE.lastIndex = 0;
  const m = email.match(EMAIL_RE);
  if (!m) return false;
  return m[0] === email;
}

// ORCID /person 字段归一：兼容两种形态
//   1. v3 /person 实际响应：字段就是裸字符串（"Wang Xiaoming"）
//   2. 部分 fixture / 内部封装：{ "value": "Wang Xiaoming" }
// 之前只读 .value，遇到裸字符串 → undefined → 整条 external-id 被丢 → capture rate 0%
// （BRA-9.4 partial run 13,820 行 0% 命中即此 bug）。修后两种形态都正常出值。
function unwrapField(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'object') {
    if (node.value != null && typeof node.value === 'string') {
      const s = node.value.trim();
      if (s) return s;
    }
    // 兜底：其它对象结构（如 { "content": "..." }）直接 JSON 序列化也不靠谱，统一返回 null
    return null;
  }
  return String(node);
}

// ORCID /person JSON 提取（保持容错：缺字段时返回空数组 / null）
function extractCreditName(personJson) {
  if (!personJson || typeof personJson !== 'object') return null;
  const name = personJson.name;
  if (!name) return null;
  // 优先 given-names + family-name
  const given = unwrapField(name['given-names']);
  const family = unwrapField(name['family-name']);
  const composed = [given, family].filter(Boolean).join(' ').trim();
  if (composed) return composed;
  // 退化 credit-name
  const credit = unwrapField(name['credit-name']);
  if (credit) return credit;
  return null;
}

function extractEmailsFromPerson(personJson) {
  if (!personJson || typeof personJson !== 'object') return [];
  const arr = (personJson.emails && personJson.emails.email) || [];
  const list = (Array.isArray(arr) ? arr : [arr]).filter(Boolean);
  const out = [];
  for (const e of list) {
    const email = e && e.email;
    if (!email) continue;
    if (!isValidEmailFormat(email)) continue;
    out.push({
      email,
      primary: !!(e.primary),
      visibility: (e.visibility && e.visibility.value) || 'public',
    });
  }
  return out;
}

function extractExternalIds(personJson) {
  if (!personJson || typeof personJson !== 'object') return [];
  const eis = personJson['external-identifiers'] && personJson['external-identifiers']['external-identifier'];
  if (!eis) return [];
  const list = (Array.isArray(eis) ? eis : [eis]).filter(Boolean);
  return list.map((e) => {
    const type = unwrapField(e['external-id-type']);
    const value = unwrapField(e['external-id-value']);
    const rel = unwrapField(e['external-id-relationship']);
    const url = unwrapField(e['external-id-url']);
    if (!type || !value) return null;
    return { type, value, relationship: rel, url };
  }).filter(Boolean);
}

function extractAffiliationsFromPerson(personJson) {
  if (!personJson || typeof personJson !== 'object') return [];
  const out = [];

  // employments
  const empWrap = personJson['employments'] && personJson['employments']['affiliation-group'];
  if (empWrap) {
    const groups = (Array.isArray(empWrap) ? empWrap : [empWrap]).filter(Boolean);
    for (const g of groups) {
      const summaries = g.summaries && g.summaries['employment-summary'];
      if (!summaries) continue;
      const list = (Array.isArray(summaries) ? summaries : [summaries]).filter(Boolean);
      for (const s of list) {
        const emp = s['employment-summary'] || s;
        const org = emp.organization;
        out.push({
          kind: 'employment',
          role: (emp['role-title'] && emp['role-title'].value) || null,
          department: (emp['department-name'] && emp['department-name'].value) || null,
          org_name: (org && org.name) || null,
          org_city: (org && org.address && org.address.city) || null,
          org_country: (org && org.address && org.address.country) || null,
          start_date: isoYearMonth(emp['start-date']),
          end_date: isoYearMonth(emp['end-date']),
        });
      }
    }
  }

  // educations
  const eduWrap = personJson['educations'] && personJson['educations']['affiliation-group'];
  if (eduWrap) {
    const groups = (Array.isArray(eduWrap) ? eduWrap : [eduWrap]).filter(Boolean);
    for (const g of groups) {
      const summaries = g.summaries && g.summaries['education-summary'];
      if (!summaries) continue;
      const list = (Array.isArray(summaries) ? summaries : [summaries]).filter(Boolean);
      for (const s of list) {
        const edu = s['education-summary'] || s;
        const org = edu.organization;
        out.push({
          kind: 'education',
          role: (edu['role-title'] && edu['role-title'].value) || null,
          department: (edu['department-name'] && edu['department-name'].value) || null,
          org_name: (org && org.name) || null,
          org_city: (org && org.address && org.address.city) || null,
          org_country: (org && org.address && org.address.country) || null,
          start_date: isoYearMonth(edu['start-date']),
          end_date: isoYearMonth(edu['end-date']),
        });
      }
    }
  }

  return out;
}

// BRA-9.4.A: 纯函数。给一份已存的 orcid_profile_json (string) 重算派生列。
// 抽出来方便单测：可以脱离 DB 验证 bug 修复前后的 capture 行为差异。
//   修复前：externalIds=[] / creditName=null（裸字符串 shape）
//   修复后：externalIds=[{type, value, ...}] / creditName='Wang Xiaoming'
function reextractFromPersonJson(profileJson) {
  let person = null;
  let parseError = null;
  if (profileJson) {
    try { person = JSON.parse(profileJson); }
    catch (err) { parseError = err.message; }
  }
  if (!person) {
    return {
      parseError,
      creditName: null,
      externalIds: [],
      affiliations: [],
    };
  }
  return {
    parseError: null,
    creditName: extractCreditName(person),
    externalIds: extractExternalIds(person),
    affiliations: extractAffiliationsFromPerson(person),
  };
}

function isoYearMonth(dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return null;
  const y = dateObj.year && dateObj.year.value;
  const m = dateObj.month && dateObj.month.value;
  if (!y) return null;
  if (!m) return `${y}`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function decodeBody(raw, encoding) {
  if (!raw) return Buffer.alloc(0);
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return require('node:zlib').gunzipSync(raw);
    if (enc === 'deflate') return require('node:zlib').inflateSync(raw);
    if (enc === 'br') return require('node:zlib').brotliDecompressSync(raw);
  } catch (_) { /* ignore */ }
  return raw;
}

// 一次 GET，200+JSON → resolve {ok:true, status, data, lastModified}
// 4xx/5xx/网络错误 → resolve {ok:false, status?, error, errorDetail}
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
        const lastModified = res.headers['last-modified'] || null;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let data = null;
          try { data = body ? JSON.parse(body) : null; } catch (err) {
            return resolve({ ok: false, status: res.statusCode, error: 'parse_error', errorDetail: err.message });
          }
          return resolve({ ok: true, status: res.statusCode, data, lastModified });
        }
        if (res.statusCode === 404) {
          return resolve({ ok: false, status: 404, error: 'not_found', errorDetail: 'ORCID iD not found' });
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
      res.on('error', (err) => {
        resolve({ ok: false, error: classifyError(err, err && err.code), errorDetail: err.message });
      });
    });
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error('socket timeout')); } catch (_) {}
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: classifyError(err, err && err.code), errorDetail: err.message });
    });
    req.end();
  });
}

function classifyError(err, code) {
  if (code === 'ENOTFOUND') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
  if (err && /timeout/i.test(err.message || '')) return 'timeout';
  return 'error';
}

function createOrcidEnrich({
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

  // 拉单个 ORCID 的 /person。返回 { ok, status, person, lastModified, error, errorDetail }
  async function fetchPerson(rawOrcidId) {
    const orcid = normalizeOrcidId(rawOrcidId);
    if (!orcid) return { ok: false, status: 0, error: 'invalid_orcid', errorDetail: String(rawOrcidId) };
    const url = `${base}/v3.0/${orcid}/person`;
    let last = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // 限速先于每次请求；只在不是第一次时也限速，避免 0-wait
      await rateLimit(new URL(url).hostname);
      const t0 = Date.now();
      const r = await getJsonOnce(url, { fetchImpl, headers, timeoutMs });
      const durationMs = Date.now() - t0;
      if (r.ok) {
        return { ok: true, status: r.status, person: r.data, lastModified: r.lastModified, durationMs };
      }
      last = { ...r, attempt, durationMs };
      // 不重试：404 / 4xx (除 429) / invalid_orcid / parse_error / too_large
      if (r.status === 404 || (r.status && r.status >= 400 && r.status < 500 && r.status !== 429)) {
        return { ok: false, status: r.status || 0, person: null, lastModified: null, error: r.error, errorDetail: r.errorDetail, durationMs };
      }
      // 重试：429 / 5xx / 网络错误
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);     // 1s / 2s / 4s
        logger.warn?.(`[orcid] ${orcid} attempt=${attempt} failed (${r.error}); retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
    return {
      ok: false,
      status: last?.status || 0,
      person: null,
      lastModified: null,
      error: last?.error || 'error',
      errorDetail: last?.errorDetail || 'exhausted retries',
      attempts: (last?.attempt ?? 0) + 1,
    };
  }

  // 把 fetchPerson 结果整理成 store.recordOrcidProfile 期望的入参
  async function processAuthor({ id, orcid }) {
    const norm = normalizeOrcidId(orcid);
    const t0 = Date.now();
    const r = await fetchPerson(orcid);
    if (!r.ok || !r.person) {
      return {
        id,
        emailOrcidId: null,
        orcidCreditName: null,
        orcidExternalIdsJson: null,
        orcidAffiliationsJson: null,
        orcidLastModified: null,
        orcidLastFetched: new Date().toISOString(),
        orcidProfileJson: null,
        emailRaw: null,
        emailSource: null,
        _ok: false,
        _status: r.status,
        _error: r.error,
        _errorDetail: r.errorDetail,
        _durationMs: Date.now() - t0,
        _orcid: norm,
      };
    }
    const emails = extractEmailsFromPerson(r.person);
    const primary = emails.find((e) => e.primary) || emails[0] || null;
    const externalIds = extractExternalIds(r.person);
    const affiliations = extractAffiliationsFromPerson(r.person);
    const creditName = extractCreditName(r.person);
    return {
      id,
      emailOrcidId: norm,
      orcidCreditName: creditName,
      orcidExternalIdsJson: JSON.stringify(externalIds),
      orcidAffiliationsJson: JSON.stringify(affiliations),
      orcidLastModified: r.lastModified || null,
      orcidLastFetched: new Date().toISOString(),
      orcidProfileJson: JSON.stringify(r.person),
      emailRaw: primary ? primary.email : null,
      emailSource: primary ? 'orcid_public_api' : null,
      _ok: true,
      _status: r.status,
      _emails: emails,
      _external_ids_count: externalIds.length,
      _affiliations_count: affiliations.length,
      _durationMs: Date.now() - t0,
      _orcid: norm,
    };
  }

  return {
    normalizeOrcidId,
    isValidEmailFormat,
    extractCreditName,
    extractEmailsFromPerson,
    extractExternalIds,
    extractAffiliationsFromPerson,
    unwrapField,
    reextractFromPersonJson,
    fetchPerson,
    processAuthor,
    headers,
    rateLimitMs,
    timeoutMs,
    userAgent,
    base,
  };
}

module.exports = {
  createOrcidEnrich,
  normalizeOrcidId,
  isValidEmailFormat,
  extractCreditName,
  extractEmailsFromPerson,
  extractExternalIds,
  extractAffiliationsFromPerson,
  unwrapField,
  reextractFromPersonJson,
  ORCID_RE,
  DEFAULT_BASE,
  DEFAULT_USER_AGENT,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
