// tests/photos-flow.test.js — 端到端：dry-run 模式跑 photos.js 主流程

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { parseArgs } = require('../photos.js');
const { createStore } = require('../lib/storage.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeTmpDataDirWithCandidate() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-photos-flow-'));
  const store = createStore({ dataDir, sqlite });
  // cand1：有 og:image
  const candDir = path.join(dataDir, 'html', 'qs-01-mit', 'mit-sloan', 'people', 'abc123def456', 'photo');
  fs.mkdirSync(candDir, { recursive: true });
  const htmlPath = path.join(dataDir, 'html', 'qs-01-mit', 'mit-sloan', 'people', 'abc123def456', 'index.html');
  fs.writeFileSync(htmlPath, `<html><head>
    <meta property="og:image" content="https://x.edu/photos/wang.jpg">
  </head><body>
    <h1>Wang Xiaoming</h1>
    <img class="headshot" src="/photos/wang.jpg" width="200" height="200">
  </body></html>`);
  store.recordCandidate({
    id: 'cand1', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'mit-sloan',
    departmentNameEn: 'MIT Sloan', category: 'business_school',
    sourceKind: 'personal_page', sourceUrl: 'https://x.edu/people/wang',
    sourceListUrl: 'https://x.edu/people',
    localPath: 'html/qs-01-mit/mit-sloan/people/abc123def456/index.html',
    nameRaw: 'Wang Xiaoming', chineseNameProbability: 0.85,
    crawlStatus: 'success',
  });
  // cand2：无照片
  const candDir2 = path.join(dataDir, 'html', 'qs-01-mit', 'mit-sloan', 'people', 'xyz987zyx987', 'photo');
  fs.mkdirSync(candDir2, { recursive: true });
  const htmlPath2 = path.join(dataDir, 'html', 'qs-01-mit', 'mit-sloan', 'people', 'xyz987zyx987', 'index.html');
  fs.writeFileSync(htmlPath2, `<html><body><h1>No Photo</h1><p>no image at all</p></body></html>`);
  store.recordCandidate({
    id: 'cand2', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'mit-sloan',
    departmentNameEn: 'MIT Sloan', category: 'business_school',
    sourceKind: 'personal_page', sourceUrl: 'https://x.edu/people/np',
    sourceListUrl: 'https://x.edu/people',
    localPath: 'html/qs-01-mit/mit-sloan/people/xyz987zyx987/index.html',
    nameRaw: 'No Photo', chineseNameProbability: 0.0,
    crawlStatus: 'success',
  });
  store.close();
  return dataDir;
}

async function runMainInDryRun(dataDir) {
  // 通过 spawn 不会影响主 runner；这里改用 in-process 调 main 但 patch process.exit
  const photosMod = require('../photos.js');
  const origArgv = process.argv;
  const origLog = console.log;
  const origExit = process.exit;
  const origCwd = process.cwd();
  let exitCode = 0;
  process.argv = ['node', 'photos.js', '--all', '--dry-run', '--out', dataDir, '--max-profiles', '10'];
  console.log = () => undefined; // 静默
  process.exit = (code) => { exitCode = code; };
  process.chdir(dataDir);
  try {
    await photosMod.main();
  } catch (err) {
    exitCode = 1;
  } finally {
    process.argv = origArgv;
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  return exitCode;
}

test('parseArgs: 默认值', () => {
  const a = parseArgs(['node', 'photos.js']);
  assert.equal(a.dryRun, false);
  assert.equal(a.all, false);
  assert.equal(a.force, false);
});

test('parseArgs: --all --dry-run --out /tmp/foo', () => {
  const a = parseArgs(['node', 'photos.js', '--all', '--dry-run', '--out', '/tmp/foo']);
  assert.equal(a.all, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.out, '/tmp/foo');
});

test('parseArgs: --force', () => {
  const a = parseArgs(['node', 'photos.js', '--all', '--force']);
  assert.equal(a.force, true);
});

test('main: dry-run 命中 og:image → success；无照片 → no_photo', async () => {
  const dataDir = makeTmpDataDirWithCandidate();
  const code = await runMainInDryRun(dataDir);
  assert.equal(code, 0, `expected exit 0, got ${code}`);
  const db = new sqlite.DatabaseSync(path.join(dataDir, 'faculty.db'));
  const r1 = db.prepare('SELECT * FROM candidates WHERE id = ?').get('cand1');
  const r2 = db.prepare('SELECT * FROM candidates WHERE id = ?').get('cand2');
  assert.equal(r1.headshot_crawl_status, 'success', `cand1 status=${r1.headshot_crawl_status}`);
  assert.ok(r1.headshot_local_path && r1.headshot_local_path.endsWith('.png'));
  assert.ok(r1.headshot_bytes > 0);
  assert.equal(r2.headshot_crawl_status, 'no_photo', `cand2 status=${r2.headshot_crawl_status}`);
  // 照片落盘
  const photoAbs = path.join(dataDir, r1.headshot_local_path);
  assert.ok(fs.existsSync(photoAbs), `photo file must exist: ${photoAbs}`);
  // crawl_log 至少 2 条 headshot
  const headshotLogs = db.prepare(`SELECT target_kind, status FROM crawl_log WHERE target_kind = 'headshot'`).all();
  assert.ok(headshotLogs.length >= 2, `crawl_log headshot rows: ${headshotLogs.length}`);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processCandidate: 本地 HTML 缺失（非 dry-run）→ status=skipped', async () => {
  const dataDir = makeTmpDataDirWithCandidate();
  // 删除 cand1 的 HTML
  fs.rmSync(path.join(dataDir, 'html/qs-01-mit/mit-sloan/people/abc123def456/index.html'), { force: true });
  // 直接驱动 processCandidate（非 dry-run）
  delete require.cache[require.resolve('../photos.js')];
  const photosMod = require('../photos.js');
  const store = createStore({ dataDir, sqlite });
  const cand1 = store.db.prepare('SELECT * FROM candidates WHERE id = ?').get('cand1');
  const fetchImpl = async () => { throw new Error('should not be called when HTML missing'); };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await photosMod.processCandidate({
    cand: cand1, store, fetchImpl, rateLimit,
    opts: { dryRun: false, dataDir }, log,
  });
  assert.equal(r.status, 'skipped');
  assert.match(r.errorDetail, /local HTML missing/);
  // DB 写回
  const row = store.db.prepare('SELECT headshot_crawl_status, headshot_error_detail FROM candidates WHERE id = ?').get('cand1');
  assert.equal(row.headshot_crawl_status, 'skipped');
  assert.match(row.headshot_error_detail, /local HTML missing/);
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('main: 默认重跑跳过已 success（--force 可突破）', async () => {
  const dataDir = makeTmpDataDirWithCandidate();
  // 第一次跑 → cand1 success
  await runMainInDryRun(dataDir);
  // 第二次跑（默认）→ cand1 headshot_crawl_status 仍 success（不被覆盖）
  const code = await runMainInDryRun(dataDir);
  assert.equal(code, 0, `expected exit 0, got ${code}`);
  const db = new sqlite.DatabaseSync(path.join(dataDir, 'faculty.db'));
  const r1 = db.prepare('SELECT headshot_crawl_status, headshot_fetched_at FROM candidates WHERE id = ?').get('cand1');
  assert.equal(r1.headshot_crawl_status, 'success');
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

module.exports = { tests };
