// fetch.js — 轻量 HTTP 抓取。
// 仅使用 node 内置 http / https，无第三方依赖。
//
// 特性：
//   - 跟随最多 5 次重定向（同 host）
//   - 单次请求超时（默认 15s），整体 deadline
//   - 指数退避重试（默认 2 次）
//   - 响应大小硬上限 8 MiB
//   - 可注入 fetcher 用于测试 / dry-run
//   - 返回结构化结果 { ok, status, finalUrl, body, contentType, bytes, durationMs, error, redirectedTo }

'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const zlib = require('node:zlib');

const DEFAULT_UA = 'brain-bankv3-faculty-crawler/1.0 (+multica; academic-research; +https://github.com/Jiayang-ee/brain-bankv3)';
const MAX_REDIRECTS = 5;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyError(err, code) {
  if (code === 'ENOTFOUND') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
  if (err && /timeout/i.test(err.message || '')) return 'timeout';
  return 'error';
}

function decodeBody(raw, encoding) {
  if (!raw) return Buffer.alloc(0);
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(raw);
    if (enc === 'deflate') return zlib.inflateSync(raw);
    if (enc === 'br') return zlib.brotliDecompressSync(raw);
  } catch (err) {
    // 解压失败时返回原始 bytes，并在外层记录
    return raw;
  }
  return raw;
}

function fetchOnce(rawUrl, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      resolve({ ok: false, error: 'invalid_url', errorDetail: err.message });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname || '/'}${url.search || ''}`,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8,zh-CN;q=0.6,zh;q=0.4',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          if (truncated) return;
          total += chunk.length;
          if (total > MAX_BYTES) {
            truncated = true;
            try { res.destroy(); } catch (_) { /* ignore */ }
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (truncated) {
            resolve({ ok: false, error: 'too_large', errorDetail: `> ${MAX_BYTES} bytes` });
            return;
          }
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, res.headers['content-encoding']);
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: decoded,
            finalUrl: rawUrl,
            contentType: res.headers['content-type'] || '',
            bytes: decoded.length,
          });
        });
        res.on('error', (err) => {
          resolve({ ok: false, error: classifyError(err, err && err.code), errorDetail: err.message });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error('socket timeout')); } catch (_) { /* ignore */ }
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: classifyError(err, err && err.code), errorDetail: err.message });
    });
    req.end();
  });
}

async function fetchWithRedirects(rawUrl, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = rawUrl;
  let redirectedTo = null;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const started = Date.now();
    const result = await fetchOnce(current, opts);
    result.durationMs = Date.now() - started;
    if (!result.ok) {
      result.finalUrl = current;
      if (redirectedTo) result.redirectedTo = redirectedTo;
      return result;
    }
    const { status, headers } = result;
    if (status >= 300 && status < 400 && headers && headers.location) {
      const next = new URL(headers.location, current).toString();
      // 只跟随同 host 的重定向
      if (new URL(next).host !== new URL(current).host) {
        result.ok = false;
        result.error = 'cross_host_redirect';
        result.errorDetail = next;
        return result;
      }
      redirectedTo = next;
      current = next;
      continue;
    }
    result.finalUrl = current;
    if (redirectedTo) result.redirectedTo = redirectedTo;
    // 标记 http 失败但 ok=true 的情况
    if (status >= 400) {
      result.ok = false;
      result.error = 'http_error';
      result.errorDetail = `HTTP ${status}`;
    }
    return result;
  }
  return { ok: false, error: 'too_many_redirects', finalUrl: current, redirectedTo };
}

async function fetchWithRetry(rawUrl, opts = {}) {
  const { retries = 2, baseDelayMs = 500, timeoutMs = 15000 } = opts;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await fetchWithRedirects(rawUrl, { timeoutMs });
    if (result.ok) return result;
    // 不重试 4xx
    if (result.error === 'http_error' && result.status && result.status >= 400 && result.status < 500) {
      return result;
    }
    last = result;
    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  return last;
}

// 简易 host-level 限速器：相同 host 至少间隔 minIntervalMs
function createRateLimiter(minIntervalMs = 1500) {
  const lastHit = new Map();
  return async function limit(host) {
    const now = Date.now();
    const last = lastHit.get(host) || 0;
    const wait = last + minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  };
}

module.exports = {
  fetchWithRetry,
  fetchOnce,
  fetchWithRedirects,
  createRateLimiter,
  DEFAULT_UA,
  MAX_BYTES,
};
