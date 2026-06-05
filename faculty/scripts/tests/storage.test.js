// tests/storage.test.js — 单元测试：SQLite 存储

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('../lib/storage.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeTmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-store-'));
  const store = createStore({ dataDir: dir, sqlite });
  return { dir, store };
}

test('createStore: 创建表 + 写入 candidate', () => {
  const { dir, store } = makeTmpStore();
  store.recordCandidate({
    id: 'abc123',
    schoolRank: 1,
    schoolNameEn: 'MIT',
    departmentId: 'mit-sloan',
    departmentNameEn: 'MIT Sloan',
    category: 'business_school',
    sourceKind: 'personal_page',
    sourceUrl: 'https://mitsloan.mit.edu/people/wang',
    sourceListUrl: 'https://mitsloan.mit.edu/people',
    localPath: 'html/qs-01-mit/mit-sloan/people/abc/index.html',
    nameRaw: 'Wang Xiaoming',
    titleRaw: 'Assistant Professor',
    emailRaw: 'wang@mit.edu',
    chineseNameProbability: 0.85,
    chineseNameReasons: [{ rule: 'cjk_chars_present' }, { rule: 'surname_known' }],
    crawlStatus: 'success',
  });
  const r = store.db.prepare('SELECT * FROM candidates WHERE id = ?').get('abc123');
  assert.ok(r);
  assert.equal(r.name_raw, 'Wang Xiaoming');
  assert.equal(r.chinese_name_probability, 0.85);
  assert.deepEqual(JSON.parse(r.chinese_name_reasons).length, 2);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: 唯一索引触发 upsert', () => {
  const { dir, store } = makeTmpStore();
  store.recordCandidate({
    id: 'a', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school', sourceKind: 'personal_page',
    sourceUrl: 'https://x/y', nameRaw: 'old', chineseNameProbability: 0.1,
    crawlStatus: 'success',
  });
  store.recordCandidate({
    id: 'b', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school', sourceKind: 'personal_page',
    sourceUrl: 'https://x/y', nameRaw: 'new', chineseNameProbability: 0.9,
    crawlStatus: 'success',
  });
  const r = store.db.prepare('SELECT * FROM candidates WHERE source_url = ?').get('https://x/y');
  // 主键 id 保持为首次插入的 'a'，但 name 等字段被 update
  assert.equal(r.id, 'a');
  assert.equal(r.name_raw, 'new');
  assert.equal(r.chinese_name_probability, 0.9);
  const count = store.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  assert.equal(count, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: crawl_log 写入', () => {
  const { dir, store } = makeTmpStore();
  store.recordCrawlLog({
    targetKind: 'list_page',
    targetUrl: 'https://x/people',
    schoolRank: 1, departmentId: 'd',
    httpStatus: 200, bytes: 12345, durationMs: 100,
    status: 'success', errorDetail: null, redirectedTo: null,
  });
  const r = store.db.prepare('SELECT * FROM crawl_log').all();
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'success');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: department_summary upsert + 计数查询', () => {
  const { dir, store } = makeTmpStore();
  store.recordCandidate({
    id: 'c1', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school', sourceKind: 'personal_page',
    sourceUrl: 'https://x/y1', nameRaw: 'Wang', chineseNameProbability: 0.8, crawlStatus: 'success',
  });
  store.recordCandidate({
    id: 'c2', schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school', sourceKind: 'personal_page',
    sourceUrl: 'https://x/y2', nameRaw: 'John', chineseNameProbability: 0.1, crawlStatus: 'success',
  });
  const counts = store.getDeptCounts(1, 'd');
  assert.equal(counts.total, 2);
  assert.equal(counts.chinese, 1);
  store.recordDepartmentSummary({
    schoolRank: 1, departmentId: 'd', departmentNameEn: 'D', entryUrl: 'https://x',
    category: 'business_school', needsJsHint: false, status: 'valid',
    discoveredListUrl: 'https://x/people', listPagesCount: 1,
    candidatesCount: counts.total, candidatesChsCount: counts.chinese,
    lastRunStatus: 'ok',
  });
  const r = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = 1 AND department_id = ?').get('d');
  assert.ok(r);
  assert.equal(r.last_run_status, 'ok');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: meta set/get', () => {
  const { dir, store } = makeTmpStore();
  store.setMeta('k', 'v');
  assert.equal(store.getMeta('k'), 'v');
  store.setMeta('k', 'v2');
  assert.equal(store.getMeta('k'), 'v2');
  assert.equal(store.getMeta('missing'), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: jsonl 落盘可读', () => {
  const { dir, store } = makeTmpStore();
  store.recordCrawlLog({
    targetKind: 'list_page', targetUrl: 'https://x/people',
    schoolRank: 1, departmentId: 'd', httpStatus: 200, bytes: 100, durationMs: 1,
    status: 'success',
  });
  store.close();
  const logFile = path.join(dir, 'crawl_log.jsonl');
  assert.ok(fs.existsSync(logFile));
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.target_url, 'https://x/people');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- BRA-8 headshot 列与 helpers ---

function seedHeadshotCandidate(store, { id, sourceUrl, headshotStatus = null } = {}) {
  store.recordCandidate({
    id,
    schoolRank: 1, schoolNameEn: 'MIT', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school',
    sourceKind: 'personal_page', sourceUrl,
    sourceListUrl: 'https://x/people',
    localPath: `html/x/d/people/${id}/index.html`,
    nameRaw: 'Wang', chineseNameProbability: 0.5,
    crawlStatus: 'success',
  });
  if (headshotStatus) {
    store.recordHeadshot({
      id,
      headshotUrl: 'https://x/p.jpg',
      headshotLocalPath: `html/x/d/people/${id}/photo/x.jpg`,
      headshotContentType: 'image/jpeg',
      headshotBytes: 1234,
      headshotCrawlStatus: headshotStatus,
    });
  }
}

test('createStore: headshot 列存在 + 写回可读', () => {
  const { dir, store } = makeTmpStore();
  seedHeadshotCandidate(store, { id: 'h1', sourceUrl: 'https://x/p1', headshotStatus: 'success' });
  const r = store.db.prepare('SELECT headshot_url, headshot_local_path, headshot_content_type, headshot_bytes, headshot_crawl_status FROM candidates WHERE id = ?').get('h1');
  assert.equal(r.headshot_url, 'https://x/p.jpg');
  assert.equal(r.headshot_bytes, 1234);
  assert.equal(r.headshot_crawl_status, 'success');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: ensureColumn 幂等 (再开一次 store 不会报错)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-store-'));
  const s1 = createStore({ dataDir: dir, sqlite });
  s1.close();
  // 第二次开同一个 db；ensureColumn 命中"已存在"分支
  const s2 = createStore({ dataDir: dir, sqlite });
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: selectPhotoCandidates 默认跳过已 success', () => {
  const { dir, store } = makeTmpStore();
  seedHeadshotCandidate(store, { id: 'h1', sourceUrl: 'https://x/p1', headshotStatus: 'success' });
  seedHeadshotCandidate(store, { id: 'h2', sourceUrl: 'https://x/p2' });
  const rows = store.selectPhotoCandidates({});
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes('h1'), '已 success 的不应被默认选中');
  assert.ok(ids.includes('h2'), '未处理的应被选中');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: selectPhotoCandidates --force 重跑', () => {
  const { dir, store } = makeTmpStore();
  seedHeadshotCandidate(store, { id: 'h1', sourceUrl: 'https://x/p1', headshotStatus: 'success' });
  const rows = store.selectPhotoCandidates({ force: true });
  assert.ok(rows.find((r) => r.id === 'h1'));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: selectPhotoCandidates 按 school_rank 过滤', () => {
  const { dir, store } = makeTmpStore();
  store.recordCandidate({
    id: 'a', schoolRank: 1, schoolNameEn: 'A', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school',
    sourceKind: 'personal_page', sourceUrl: 'https://x/1',
    localPath: 'html/a/d/people/a/index.html', nameRaw: 'A', chineseNameProbability: 0, crawlStatus: 'success',
  });
  store.recordCandidate({
    id: 'b', schoolRank: 2, schoolNameEn: 'B', departmentId: 'd',
    departmentNameEn: 'D', category: 'business_school',
    sourceKind: 'personal_page', sourceUrl: 'https://x/2',
    localPath: 'html/b/d/people/b/index.html', nameRaw: 'B', chineseNameProbability: 0, crawlStatus: 'success',
  });
  const rows = store.selectPhotoCandidates({ schoolRank: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore: getHeadshotStats 正确分类', () => {
  const { dir, store } = makeTmpStore();
  seedHeadshotCandidate(store, { id: 'h1', sourceUrl: 'https://x/p1', headshotStatus: 'success' });
  seedHeadshotCandidate(store, { id: 'h2', sourceUrl: 'https://x/p2', headshotStatus: 'no_photo' });
  seedHeadshotCandidate(store, { id: 'h3', sourceUrl: 'https://x/p3', headshotStatus: 'anti_leech_suspected' });
  seedHeadshotCandidate(store, { id: 'h4', sourceUrl: 'https://x/p4' });
  const stats = store.getHeadshotStats();
  assert.equal(stats.distribution.success, 1);
  assert.equal(stats.distribution.no_photo, 1);
  assert.equal(stats.distribution.anti_leech_suspected, 1);
  assert.equal(stats.totals.total, 4);
  assert.equal(stats.totals.success, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { tests };
