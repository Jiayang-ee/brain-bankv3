#!/usr/bin/env node
// viewer.js — 本地网页查看器主入口 (BRA-10)
//
// 用法：
//   node faculty/scripts/viewer.js                         # 默认配置（faculty/data/faculty.db, 7788 端口）
//   node faculty/scripts/viewer.js --port 8080             # 自定义端口
//   node faculty/scripts/viewer.js --db /path/to/faculty.db
//   node faculty/scripts/viewer.js --data-dir /path/to/dir
//   node faculty/scripts/viewer.js --open                  # 启动后自动打开浏览器
//   node faculty/scripts/viewer.js --host 0.0.0.0          # 监听所有网卡
//
// 退出码：
//   0 = 正常退出（用户 Ctrl-C）
//   1 = 参数错误 / DB 不存在 / 端口占用

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const api = require('./lib/viewer_api.js');
const { createServer } = require('./lib/viewer_server.js');

function parseArgs(argv) {
  const out = {
    port: 7788,
    host: '127.0.0.1',
    db: null,
    dataDir: null,
    staticDir: null,
    open: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host' || a === '-H') out.host = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--static-dir') out.staticDir = argv[++i];
    else if (a === '--open') out.open = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').match(/## BRA-10[\s\S]*?(?=\n## |\n$)/)?.[0] || 'see README.md BRA-10 section');
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function defaultDbPath() {
  // 仓库根 → faculty/data/faculty.db（默认跑批产物）
  return path.join(process.cwd(), 'faculty', 'data', 'faculty.db');
}

function defaultDataDir(dbPath) {
  return path.dirname(dbPath);
}

function defaultStaticDir() {
  return path.join(process.cwd(), 'faculty', 'viewer');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch (_) { /* ignore */ }
}

async function main() {
  const opts = parseArgs(process.argv);

  // 1) 解析 db 路径
  const dbPath = path.resolve(opts.db || defaultDbPath());
  if (!fs.existsSync(dbPath)) {
    console.error(`[viewer] faculty.db not found: ${dbPath}`);
    console.error(`[viewer] run one of:`);
    console.error(`[viewer]   node faculty/scripts/discover.js --all --dry-run --out <data-dir>`);
    console.error(`[viewer]   node faculty/scripts/papers.js --all --dry-run --out <data-dir>`);
    console.error(`[viewer] then re-run viewer with --db <data-dir>/faculty.db`);
    process.exit(1);
  }
  const dataDir = path.resolve(opts.dataDir || defaultDataDir(dbPath));
  const staticDir = path.resolve(opts.staticDir || defaultStaticDir());
  if (!fs.existsSync(staticDir)) {
    console.error(`[viewer] static dir not found: ${staticDir}`);
    process.exit(1);
  }

  // 2) 打开 DB
  const db = api.openDatabase(dbPath);
  const cols = api.hasPaperAuthorReviewColumns(db);
  if (!cols.review_status) {
    console.warn('[viewer] NOTE: paper_authors.review_status column missing.');
    console.warn('[viewer]       Paper-candidate review writes will be no-ops (persisted=false).');
    console.warn('[viewer]       Wait for BRA-23 to land to enable persistence.');
  }
  const stats = api.getStats(db);
  if (opts.verbose) {
    console.error(`[viewer] db: ${dbPath}`);
    console.error(`[viewer] dataDir: ${dataDir}`);
    console.error(`[viewer] staticDir: ${staticDir}`);
    console.error(`[viewer] stats: faculty=${stats.faculty.total} paper=${stats.paper.total}`);
  }

  // 3) 启动 HTTP 服务
  const server = createServer({ api: {
    getStats: () => api.getStats(db),
    getFacets: () => api.getFacets(db),
    listCandidates: (source, q) => api.listCandidates(db, source, q),
    getCandidate: (source, id) => api.getCandidate(db, source, id),
    updateFacultyReview: (id, p) => api.updateFacultyReview(db, id, p),
    updatePaperReview: (id, p) => api.updatePaperReview(db, id, p),
  }, staticDir, dataDir });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const url = `http://${opts.host}:${opts.port}/`;
  console.log(`[viewer] listening on ${url}`);
  console.log(`[viewer] db: ${dbPath}`);
  console.log(`[viewer] dataDir: ${dataDir}`);
  console.log(`[viewer] candidates: faculty=${stats.faculty.total} (chinese_likely=${stats.faculty.chinese_likely})  paper=${stats.paper.total} (chinese_likely=${stats.paper.chinese_likely})`);
  console.log(`[viewer] press Ctrl-C to stop`);

  if (opts.open) {
    // 异步打开，不阻塞
    setTimeout(() => openBrowser(url), 200);
  }

  // 4) 等待退出
  const shutdown = () => {
    console.log('\n[viewer] shutting down…');
    server.close(() => {
      api.closeDatabase(db);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[viewer] port ${process.env.PORT || ''} already in use`);
  } else {
    console.error('[viewer] fatal:', e.stack || e.message);
  }
  process.exit(1);
});
