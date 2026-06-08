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

// --- BRA-10.1 paper_authors 审核字段 ---

// 最小可用的 paper 写入行（满足 paper_authors 的外键约束）
// papers.journal_id 外键引用 journals.id，必须先 recordJournal
function seedPaper(store, { id, journalName = 'MS', title = 'Test' } = {}) {
  store.recordJournal({
    id: 'j-' + id,
    sourceFile: 'test.csv',
    journalNameRaw: journalName,
    journalSystem: '英文期刊',
    schoolLevel: 'A+',
    issnPrint: '00251909',
    queryStatus: 'pending',
  });
  store.recordPaper({
    id,
    doi: '10.1/' + id,
    title,
    journalId: 'j-' + id,
    journalName,
    issn: '00251909',
    publishYear: 2023,
    publishDate: '2023-01-01',
    paperType: 'article',
    source: 'openalex',
    sourceUrl: 'https://openalex.org/W' + id,
  });
}

test('BRA-10.1: paper_authors 默认值 review_status=pending, review_notes=null', () => {
  const { dir, store } = makeTmpStore();
  seedPaper(store, { id: 'p1' });
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang Xiaoming', authorPosition: 0,
    isFirstAuthor: true, isLastAuthor: false, isCorresponding: false,
    chineseNameProbability: 0.8,
  });
  const r = store.db.prepare('SELECT review_status, review_notes FROM paper_authors WHERE id = ?').get('pa1');
  assert.equal(r.review_status, 'pending');
  assert.equal(r.review_notes, null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: recordPaperAuthor 写入 reviewStatus / reviewNotes', () => {
  const { dir, store } = makeTmpStore();
  seedPaper(store, { id: 'p1' });
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, chineseNameProbability: 0.9,
    reviewStatus: 'approved',
    reviewNotes: '已确认是清华教授',
  });
  const r = store.db.prepare('SELECT review_status, review_notes FROM paper_authors WHERE id = ?').get('pa1');
  assert.equal(r.review_status, 'approved');
  assert.equal(r.review_notes, '已确认是清华教授');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: updatePaperAuthorReview 写回审核状态/备注', () => {
  const { dir, store } = makeTmpStore();
  seedPaper(store, { id: 'p1' });
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, chineseNameProbability: 0.9,
  });
  const ret = store.updatePaperAuthorReview({
    id: 'pa1', reviewStatus: 'rejected', reviewNotes: '重名无法判断',
  });
  assert.equal(ret.changes, 1);
  const r = store.db.prepare('SELECT review_status, review_notes FROM paper_authors WHERE id = ?').get('pa1');
  assert.equal(r.review_status, 'rejected');
  assert.equal(r.review_notes, '重名无法判断');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: updatePaperAuthorReview 不修改其他字段', () => {
  const { dir, store } = makeTmpStore();
  seedPaper(store, { id: 'p1' });
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: '陈晓', authorPosition: 0,
    isFirstAuthor: true, isLastAuthor: false, isCorresponding: true,
    affiliationName: 'SJTU', chineseNameProbability: 0.95,
    chineseNameReasons: [{ rule: 'cjk_chars_present' }],
  });
  store.updatePaperAuthorReview({ id: 'pa1', reviewStatus: 'approved', reviewNotes: 'ok' });
  const r = store.getPaperAuthor('pa1');
  assert.equal(r.author_name, '陈晓');
  assert.equal(r.affiliation_name, 'SJTU');
  assert.equal(r.is_first_author, 1);
  assert.equal(r.is_corresponding, 1);
  assert.equal(r.chinese_name_probability, 0.95);
  assert.equal(r.review_status, 'approved');
  assert.equal(r.review_notes, 'ok');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: upsert 旧 author 时不覆盖人工审核字段（不写入 ON CONFLICT SET）', () => {
  const { dir, store } = makeTmpStore();
  seedPaper(store, { id: 'p1' });
  // 第一次写入：审核员先打 'approved'
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, chineseNameProbability: 0.9,
    reviewStatus: 'approved',
    reviewNotes: '审核通过',
  });
  // 第二次写入：上游重抓时仍然传了 reviewStatus='pending'，但 ON CONFLICT 不更新审核字段
  store.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang Updated', authorPosition: 0,
    isFirstAuthor: true, chineseNameProbability: 0.92,
  });
  const r = store.db.prepare('SELECT author_name, chinese_name_probability, review_status, review_notes FROM paper_authors WHERE id = ?').get('pa1');
  // author_name / chinese_name_probability 应被覆盖
  assert.equal(r.author_name, 'Wang Updated');
  assert.equal(r.chinese_name_probability, 0.92);
  // 审核字段应保留（与 candidates 策略一致）
  assert.equal(r.review_status, 'approved');
  assert.equal(r.review_notes, '审核通过');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: ensureColumn 迁移在旧 DB（无 review 列）上幂等补齐', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bra10-migrate-'));
  // 1) 先开 store，删除 review_* 列 + 相关索引模拟"老 DB"
  const s1 = createStore({ dataDir: dir, sqlite });
  s1.db.exec('DROP INDEX IF EXISTS idx_pa_review');
  s1.db.exec('ALTER TABLE paper_authors DROP COLUMN review_status');
  s1.db.exec('ALTER TABLE paper_authors DROP COLUMN review_notes');
  s1.close();

  // 2) 重新打开：ensureColumn 应当把 review_status / review_notes 补回来
  const s2 = createStore({ dataDir: dir, sqlite });
  const cols = s2.db.prepare('PRAGMA table_info(paper_authors)').all().map((c) => c.name);
  assert.ok(cols.includes('review_status'), 'review_status 应被 ensureColumn 补齐');
  assert.ok(cols.includes('review_notes'), 'review_notes 应被 ensureColumn 补齐');
  // 默认值应仍是 'pending' / null（新行才能立即写入审核字段）
  seedPaper(s2, { id: 'p1' });
  s2.recordPaperAuthor({
    id: 'pa1', paperId: 'p1', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, chineseNameProbability: 0.9,
  });
  const r = s2.db.prepare('SELECT review_status, review_notes FROM paper_authors WHERE id = ?').get('pa1');
  assert.equal(r.review_status, 'pending');
  assert.equal(r.review_notes, null);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRA-10.1: getPaperAuthor 缺失 id 返回 null', () => {
  const { dir, store } = makeTmpStore();
  assert.equal(store.getPaperAuthor('not-exist'), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { tests };
