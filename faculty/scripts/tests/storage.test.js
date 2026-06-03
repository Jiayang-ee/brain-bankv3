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

module.exports = { tests };
