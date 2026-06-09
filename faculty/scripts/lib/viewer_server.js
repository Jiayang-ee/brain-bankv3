// viewer_server.js — 本地网页查看器 HTTP 服务 (BRA-10)。
//
// 零第三方依赖：只用 node:http + node:fs + node:path + node:url。
//
// createServer({ api, staticDir, dataDir }) → server
//
// 路由：
//   GET    /                                      → 静态 index.html
//   GET    /assets/<file>                         → 静态资源（限制在 staticDir 内）
//   GET    /api/candidates?source=faculty|paper&… → 候选人列表
//   GET    /api/candidates/:id?source=…           → 详情
//   PATCH  /api/candidates/:id?source=…           → 更新 review_status / review_notes
//   GET    /api/facets                            → 维度字典
//   GET    /api/stats                             → 顶层计数
//   GET    /html/<encoded-relative-path>          → 静态归档 HTML（dataDir 内）
//   GET    /photo/<encoded-relative-path>         → 静态归档图片
//
// :id = "<source>:<original-id>"，例如 "faculty:abc123" / "paper:sha1..."

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const REVIEW_STATUSES = ['pending', 'confirmed', 'excluded', 'focus'];

function jsonResponse(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function errResponse(res, status, message, code) {
  jsonResponse(res, status, { error: { message, code: code || null } });
}

// 把 URL 路径安全映射到 dataDir 下的本地文件。
// 防目录遍历：解 URL-decode 后必须落在 dataDir 之下。
function resolveSafeFile(dataDir, urlPath, kind) {
  // urlPath 是去除前导斜杠的相对路径（kind 决定前缀）
  // 1. 拒绝空 / null 字节 / 反斜杠
  if (!urlPath || urlPath.includes('\0') || urlPath.includes('\\')) return null;
  // 2. URL-decode 已经在 req.url 解析时处理
  // 3. 拆段，每段不能是 . 或 .. 或含 ..
  const parts = urlPath.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('..')) return null;
  }
  // 4. 拼到 dataDir 后规范化，必须以 dataDir + 路径分隔符开头
  const resolved = path.resolve(dataDir, ...parts);
  const normData = path.resolve(dataDir);
  if (resolved !== normData && !resolved.startsWith(normData + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return null;
  return resolved;
}

function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js':  return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function serveStaticFile(res, filePath) {
  const stat = fs.statSync(filePath);
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeFromPath(filePath),
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseId(raw) {
  // :id = "faculty:abc" or "paper:sha1..."
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const source = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (source !== 'faculty' && source !== 'paper') return null;
  if (!id) return null;
  return { source, id };
}

function createServer({ api, staticDir, dataDir }) {
  if (!api) throw new Error('createServer: api required');
  const statDir = staticDir ? path.resolve(staticDir) : null;
  const dataRoot = dataDir ? path.resolve(dataDir) : null;

  const server = http.createServer(async (req, res) => {
    let u;
    try {
      u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      return errResponse(res, 400, `invalid URL: ${req.url}`);
    }
    const pathname = decodeURIComponent(u.pathname);

    try {
      // ─── 静态资源 ─────────────────────────────────
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const indexFile = path.join(statDir, 'index.html');
        if (!statDir || !fs.existsSync(indexFile)) {
          return errResponse(res, 500, 'viewer index.html not found', 'NO_INDEX');
        }
        return serveStaticFile(res, indexFile);
      }
      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        const rel = pathname.slice('/assets/'.length);
        const safe = resolveSafeFile(statDir, rel, 'assets');
        if (!safe) return errResponse(res, 404, 'asset not found', 'NOT_FOUND');
        return serveStaticFile(res, safe);
      }
      if (req.method === 'GET' && (pathname.startsWith('/html/') || pathname.startsWith('/photo/'))) {
        const kind = pathname.startsWith('/html/') ? 'html' : 'photo';
        if (!dataRoot) return errResponse(res, 500, 'dataDir not configured', 'NO_DATA_DIR');
        const rel = pathname.slice(kind.length + 2); // strip '/html/' or '/photo/'
        const safe = resolveSafeFile(dataRoot, rel, kind);
        if (!safe) return errResponse(res, 404, `${kind} file not found`, 'NOT_FOUND');
        return serveStaticFile(res, safe);
      }

      // ─── API ─────────────────────────────────────
      if (pathname === '/api/stats' && req.method === 'GET') {
        return jsonResponse(res, 200, { ok: true, data: api.getStats() });
      }
      if (pathname === '/api/facets' && req.method === 'GET') {
        return jsonResponse(res, 200, { ok: true, data: api.getFacets() });
      }
      if (pathname === '/api/candidates' && req.method === 'GET') {
        const source = u.searchParams.get('source') || 'faculty';
        if (source !== 'faculty' && source !== 'paper') {
          return errResponse(res, 400, `invalid source: ${source}`, 'EINVAL');
        }
        const query = {};
        for (const [k, v] of u.searchParams.entries()) {
          if (k === 'source') continue;
          if (query[k] != null) {
            if (Array.isArray(query[k])) query[k].push(v);
            else query[k] = [query[k], v];
          } else {
            query[k] = v;
          }
        }
        const result = api.listCandidates(source, query);
        return jsonResponse(res, 200, { ok: true, ...result, source });
      }

      const m = pathname.match(/^\/api\/candidates\/(.+)$/);
      if (m) {
        const parsed = parseId(m[1]);
        if (!parsed) return errResponse(res, 400, 'invalid id; expected "<source>:<id>"', 'EINVAL');
        if (req.method === 'GET') {
          const row = api.getCandidate(parsed.source, parsed.id);
          if (!row) return errResponse(res, 404, 'candidate not found', 'NOT_FOUND');
          return jsonResponse(res, 200, { ok: true, data: row });
        }
        if (req.method === 'PATCH') {
          let body;
          try { body = await readJsonBody(req); }
          catch (e) { return errResponse(res, 400, e.message, 'BAD_BODY'); }
          const status = body.review_status;
          if (!REVIEW_STATUSES.includes(status)) {
            return errResponse(res, 400,
              `invalid review_status: ${status}; allowed: ${REVIEW_STATUSES.join(',')}`,
              'EINVAL');
          }
          const notes = body.review_notes != null ? String(body.review_notes).slice(0, 4096) : null;
          let r;
          try {
            r = parsed.source === 'faculty'
              ? api.updateFacultyReview(parsed.id, { review_status: status, review_notes: notes })
              : api.updatePaperReview(parsed.id, { review_status: status, review_notes: notes });
          } catch (e) {
            if (e.code === 'EINVAL') return errResponse(res, 400, e.message, 'EINVAL');
            throw e;
          }
          if (r.persisted === false) {
            return jsonResponse(res, 200, {
              ok: true,
              data: { id: m[1], source: parsed.source, review_status: r.status, review_notes: r.notes, persisted: false },
              warning: r.reason,
            });
          }
          if (r.updated === 0) {
            return errResponse(res, 404, 'candidate not found', 'NOT_FOUND');
          }
          return jsonResponse(res, 200, {
            ok: true,
            data: { id: m[1], source: parsed.source, review_status: r.status, review_notes: r.notes, persisted: true },
          });
        }
        return errResponse(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED');
      }

      return errResponse(res, 404, `not found: ${pathname}`, 'NOT_FOUND');
    } catch (e) {
      console.error('[viewer] error:', e);
      return errResponse(res, 500, e.message || 'internal error', 'INTERNAL');
    }
  });

  return server;
}

module.exports = { createServer, resolveSafeFile, parseId, REVIEW_STATUSES };
