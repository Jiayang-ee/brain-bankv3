// tests/viewer_api.test.js — 本地网页查看器 (BRA-10) 数据层单元测试。
// 零第三方依赖，纯 node:assert + node:sqlite + 内存/tmp DB。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sqlite = require('node:sqlite');

const api = require('../lib/viewer_api.js');
const { createStore, SCHEMA_SQL } = require('../lib/storage.js');
const serverMod = require('../lib/viewer_server.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 工具：临时建一个 store + 写若干 faculty / paper_author 行
function bootstrap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-api-'));
  const store = createStore({ dataDir: dir, sqlite });
  // 写 5 个 faculty personal_page 候选人
  for (let i = 0; i < 5; i += 1) {
    store.recordCandidate({
      id: `fac-${i}`,
      schoolRank: 1 + i,
      schoolNameEn: `University ${i}`,
      departmentId: `dept-${i}`,
      departmentNameEn: `Department ${i}`,
      category: i % 2 === 0 ? 'business_school' : 'operations_research',
      sourceKind: 'personal_page',
      sourceUrl: `https://x.edu/p${i}`,
      sourceListUrl: `https://x.edu/people`,
      localPath: `html/qs-0${i+1}-u${i}/dept-${i}/people/abc/index.html`,
      nameRaw: i === 0 ? 'Wang Xiaoming' : `Person ${i}`,
      titleRaw: 'Assistant Professor',
      emailRaw: i === 0 ? 'wxm@x.edu' : null,
      chineseNameProbability: [0.95, 0.7, 0.45, 0.2, 0.1][i],
      chineseNameReasons: [{ rule: 'surname_known', detail: 'wang' }],
      crawlStatus: 'success',
    });
  }
  // 写 1 个 list_page（应当被过滤掉）
  store.recordCandidate({
    id: 'fac-list', schoolRank: 1, schoolNameEn: 'University 0', departmentId: 'dept-0',
    departmentNameEn: 'Department 0', category: 'business_school', sourceKind: 'list_page',
    sourceUrl: 'https://x.edu/people', nameRaw: 'list page', chineseNameProbability: 0,
    crawlStatus: 'success',
  });
  // 写一个 journal（先写，避免 paper 的 FK 失败）
  store.recordJournal({
    id: 'j-mgmt-sci',
    sourceFile: 'journals.csv',
    journalSystem: '英文期刊',
    journalNameRaw: 'Management Science',
    journalNameEn: 'Management Science',
    issnRaw: '0025-1909',
    issnPrint: '0025-1909',
    queryStatus: 'success',
  });
  // 写 3 个 paper_author（其中 2 个是 target_candidate）
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    store.recordPaper({
      id: `paper-${i}`,
      doi: `10.1234/paper-${i}`,
      title: `Paper ${i} title`,
      journalId: 'j-mgmt-sci',
      journalName: 'Management Science',
      issn: '0025-1909',
      publishYear: 2024,
      publishDate: '2024-06-01',
      source: 'openalex',
      sourceUrl: `https://api.openalex.org/W${i}`,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    store.recordPaperAuthor({
      id: `pa-${i}`,
      paperId: `paper-${i}`,
      authorName: i === 0 ? 'Wang Xiaoming' : `Author ${i}`,
      authorPosition: i,
      isFirstAuthor: i === 0 ? 1 : 0,
      isLastAuthor: i === 2 ? 1 : 0,
      isCorresponding: 0,
      affiliationRaw: 'MIT',
      affiliationId: 'mit',
      affiliationName: 'MIT',
      orcid: null,
      chineseNameProbability: [0.95, 0.6, 0.3][i],
      chineseNameReasons: [{ rule: 'surname_known', detail: 'wang' }],
      chineseNameNegatives: [],
      isTargetCandidate: i < 2 ? 1 : 0,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
  store.close();
  return { dir, dbPath: path.join(dir, 'faculty.db') };
}

test('listFacultyCandidates: 只返回 personal_page，过滤 list_page', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.listCandidates(db, 'faculty', {});
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 5);
  for (const row of r.rows) {
    assert.equal(row.source, 'faculty');
    assert.ok(row.id.startsWith('faculty:'));
  }
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listFacultyCandidates: min_chs 过滤', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.listCandidates(db, 'faculty', { min_chs: 0.5 });
  assert.equal(r.total, 2);
  for (const row of r.rows) assert.ok(row.chinese_name_probability >= 0.5);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listFacultyCandidates: 关键词搜索跨 name/email', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r1 = api.listCandidates(db, 'faculty', { q: 'Wang' });
  assert.equal(r1.total, 1);
  assert.equal(r1.rows[0].name, 'Wang Xiaoming');
  const r2 = api.listCandidates(db, 'faculty', { q: 'wxm@x.edu' });
  assert.equal(r2.total, 1);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listFacultyCandidates: 排序 + 分页', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r1 = api.listCandidates(db, 'faculty', { sort: 'chs_desc', page_size: 2, page: 1 });
  assert.equal(r1.rows.length, 2);
  assert.equal(r1.rows[0].chinese_name_probability, 0.95);
  assert.equal(r1.rows[1].chinese_name_probability, 0.7);
  const r2 = api.listCandidates(db, 'faculty', { sort: 'chs_desc', page_size: 2, page: 2 });
  assert.equal(r2.rows[0].chinese_name_probability, 0.45);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listFacultyCandidates: school_rank 多值过滤', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.listCandidates(db, 'faculty', { school_rank: '1,3' });
  assert.equal(r.total, 2);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listPaperCandidates: 只返回 is_target_candidate=1', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.listCandidates(db, 'paper', {});
  assert.equal(r.total, 2);
  for (const row of r.rows) {
    assert.equal(row.source, 'paper');
    assert.ok(row.paper);
    assert.equal(row.paper.journal_name, 'Management Science');
  }
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getCandidate: faculty 详情', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.getCandidate(db, 'faculty', 'fac-0');
  assert.equal(r.name, 'Wang Xiaoming');
  assert.equal(r.email, 'wxm@x.edu');
  assert.equal(r.local_path, 'html/qs-01-u0/dept-0/people/abc/index.html');
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getCandidate: paper 详情含 paper/journal 关联', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.getCandidate(db, 'paper', 'pa-0');
  assert.equal(r.paper.title, 'Paper 0 title');
  assert.equal(r.paper.journal_name, 'Management Science');
  assert.equal(r.paper.is_first_author, true);
  assert.equal(r.paper.doi, '10.1234/paper-0');
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateFacultyReview: 写回 + 校验', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.updateFacultyReview(db, 'fac-0', { review_status: 'confirmed', review_notes: 'verified by hand' });
  assert.equal(r.updated, 1);
  const row = db.prepare('SELECT review_status, review_notes FROM candidates WHERE id = ?').get('fac-0');
  assert.equal(row.review_status, 'confirmed');
  assert.equal(row.review_notes, 'verified by hand');
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateFacultyReview: 拒绝非法 status', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  assert.throws(() => api.updateFacultyReview(db, 'fac-0', { review_status: 'bogus' }), /invalid/);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updatePaperReview: 缺字段时返回 persisted=false', () => {
  // 模拟 BRA-10.1 之前的老库：手工建一个不带 review_status / review_notes 的 paper_authors 表
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-paper-legacy-'));
  const dbPath = path.join(dir, 'faculty.db');
  const initDb = new sqlite.DatabaseSync(dbPath);
  initDb.exec(`
    CREATE TABLE paper_authors (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_position INTEGER NOT NULL,
      is_first_author INTEGER NOT NULL DEFAULT 0,
      is_last_author INTEGER NOT NULL DEFAULT 0,
      is_corresponding INTEGER NOT NULL DEFAULT 0,
      chinese_name_probability REAL DEFAULT 0,
      is_target_candidate INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO paper_authors (id, paper_id, author_name, author_position, chinese_name_probability, is_target_candidate)
      VALUES ('pa-legacy', 'p-legacy', 'Wang Legacy', 0, 0.9, 1);
  `);
  initDb.close();

  const db = api.openDatabase(dbPath);
  const r = api.updatePaperReview(db, 'pa-legacy', { review_status: 'confirmed', review_notes: 'ok' });
  assert.equal(r.persisted, false);
  assert.equal(r.updated, 0);
  assert.match(r.reason, /review_status column missing/);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updatePaperReview: 字段就位时正常写回', () => {
  // BRA-10.1 起，createStore 已经默认带上 review_status / review_notes 两列；此处直接用 bootstrap() 即可。
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const r = api.updatePaperReview(db, 'pa-0', { review_status: 'focus', review_notes: '重点' });
  assert.equal(r.persisted, true);
  assert.equal(r.updated, 1);
  const row = db.prepare('SELECT review_status, review_notes FROM paper_authors WHERE id = ?').get('pa-0');
  assert.equal(row.review_status, 'focus');
  assert.equal(row.review_notes, '重点');
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getFacets: 包含 schools / departments / categories / review_status', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const f = api.getFacets(db);
  assert.ok(f.schools.length >= 5);
  assert.ok(f.departments.length >= 5);
  assert.ok(f.categories.length >= 2);
  assert.ok(f.review_status.find((s) => s.id === 'pending'));
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getStats: 计数正确', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const s = api.getStats(db);
  assert.equal(s.faculty.total, 5);
  assert.equal(s.faculty.chinese_likely, 3); // 0.95, 0.7, 0.45
  assert.equal(s.paper.total, 2);
  assert.equal(s.paper.chinese_likely, 2);
  assert.deepEqual(s.review_status_enum, ['pending', 'confirmed', 'excluded', 'focus']);
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hasPaperAuthorReviewColumns: 缺列返回空对象', () => {
  // 构造一个不带 review_status / review_notes 的最小 schema，模拟 BRA-10.1 之前的老库
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-cols-legacy-'));
  const dbPath = path.join(dir, 'faculty.db');
  const initDb = new sqlite.DatabaseSync(dbPath);
  initDb.exec(`
    CREATE TABLE paper_authors (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_position INTEGER NOT NULL,
      is_first_author INTEGER NOT NULL DEFAULT 0,
      is_last_author INTEGER NOT NULL DEFAULT 0,
      is_corresponding INTEGER NOT NULL DEFAULT 0,
      chinese_name_probability REAL DEFAULT 0,
      is_target_candidate INTEGER NOT NULL DEFAULT 0
    );
  `);
  initDb.close();

  const db = api.openDatabase(dbPath);
  const cols = api.hasPaperAuthorReviewColumns(db);
  assert.deepEqual(cols, {});
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hasPaperAuthorReviewColumns: 字段就位时返回 { review_status: true, review_notes: true }', () => {
  const { dir, dbPath } = bootstrap();
  const db = api.openDatabase(dbPath);
  const cols = api.hasPaperAuthorReviewColumns(db);
  assert.deepEqual(cols, { review_status: true, review_notes: true });
  api.closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeQuery: 数组 / 标量 / 默认值', () => {
  const a = api.normalizeQuery({ review_status: ['pending', 'confirmed'] });
  assert.deepEqual(a.review_status, ['pending', 'confirmed']);
  const b = api.normalizeQuery({ review_status: 'pending' });
  assert.deepEqual(b.review_status, ['pending']);
  const c = api.normalizeQuery({});
  assert.equal(c.page, 1);
  assert.equal(c.page_size, 50);
  assert.equal(c.sort, 'chs_desc');
  const d = api.normalizeQuery({ page_size: 99999 });
  assert.equal(d.page_size, 200); // cap
  const e = api.normalizeQuery({ min_chs: 0.4, max_chs: 0.8 });
  assert.equal(e.min_chs, 0.4);
  assert.equal(e.max_chs, 0.8);
});

// ─── HTTP server tests ─────────────────────────────────────

function makeApiBundle(dbPath) {
  const db = api.openDatabase(dbPath);
  const bundle = {
    api: {
      getStats: () => api.getStats(db),
      getFacets: () => api.getFacets(db),
      listCandidates: (source, q) => api.listCandidates(db, source, q),
      getCandidate: (source, id) => api.getCandidate(db, source, id),
      updateFacultyReview: (id, p) => api.updateFacultyReview(db, id, p),
      updatePaperReview: (id, p) => api.updatePaperReview(db, id, p),
    },
    db,
    closeDb: () => api.closeDatabase(db),
    dataDir: path.dirname(dbPath),
  };
  return bundle;
}

function startServer(bundle, staticDir) {
  const srv = serverMod.createServer({ api: bundle.api, staticDir, dataDir: bundle.dataDir });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv });
    });
  });
}
function fetchJson(srv, method, path, body) {
  const addr = srv.address();
  return new Promise((resolve, reject) => {
    const opts = { host: addr.address, port: addr.port, path, method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(buf.toString('utf8') || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: buf.toString('utf8') }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP: GET /api/stats', async () => {
  const { dir, dbPath } = bootstrap();
  const bundle = makeApiBundle(dbPath);
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-static-'));
  fs.writeFileSync(path.join(dirS, 'index.html'), '<html></html>');
  const { srv } = await startServer(bundle, dirS);
  const r = await fetchJson(srv, 'GET', '/api/stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.faculty.total, 5);
  srv.close();
  bundle.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirS, { recursive: true, force: true });
});

test('HTTP: GET /api/candidates?source=faculty&min_chs=0.5', async () => {
  const { dir, dbPath } = bootstrap();
  const bundle = makeApiBundle(dbPath);
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-static-'));
  fs.writeFileSync(path.join(dirS, 'index.html'), '<html></html>');
  const { srv } = await startServer(bundle, dirS);
  const r = await fetchJson(srv, 'GET', '/api/candidates?source=faculty&min_chs=0.5');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.source, 'faculty');
  srv.close();
  bundle.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirS, { recursive: true, force: true });
});

test('HTTP: PATCH /api/candidates/faculty:fac-0 → confirmed', async () => {
  const { dir, dbPath } = bootstrap();
  const bundle = makeApiBundle(dbPath);
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-static-'));
  fs.writeFileSync(path.join(dirS, 'index.html'), '<html></html>');
  const { srv } = await startServer(bundle, dirS);
  const r = await fetchJson(srv, 'PATCH', '/api/candidates/faculty:fac-0',
    JSON.stringify({ review_status: 'confirmed', review_notes: 'verify' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.persisted, true);
  assert.equal(r.body.data.review_status, 'confirmed');
  // 再读一次校验持久化
  const r2 = await fetchJson(srv, 'GET', '/api/candidates/faculty:fac-0?source=faculty');
  assert.equal(r2.body.data.review_status, 'confirmed');
  assert.equal(r2.body.data.review_notes, 'verify');
  srv.close();
  bundle.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirS, { recursive: true, force: true });
});

test('HTTP: PATCH 论文作者在缺列时返回 persisted=false + warning', async () => {
  // 构造一个不带 paper_authors.review_status / review_notes 的最小 schema，模拟
  // BRA-10.1 之前的老库；此时 viewer 必须降级为 no-op 并返回 warning。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-paper-legacy-'));
  const dbPath = path.join(dir, 'faculty.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE paper_authors (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_position INTEGER NOT NULL,
      is_first_author INTEGER NOT NULL DEFAULT 0,
      is_last_author INTEGER NOT NULL DEFAULT 0,
      is_corresponding INTEGER NOT NULL DEFAULT 0,
      chinese_name_probability REAL DEFAULT 0,
      is_target_candidate INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO paper_authors (id, paper_id, author_name, author_position, chinese_name_probability, is_target_candidate)
      VALUES ('pa-legacy', 'p-legacy', 'Wang Legacy', 0, 0.9, 1);
  `);
  db.close();

  const bundle = makeApiBundle(dbPath);
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-static-'));
  fs.writeFileSync(path.join(dirS, 'index.html'), '<html></html>');
  const { srv } = await startServer(bundle, dirS);
  const r = await fetchJson(srv, 'PATCH', '/api/candidates/paper:pa-legacy',
    JSON.stringify({ review_status: 'focus' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.persisted, false);
  assert.match(r.body.warning, /review_status column missing/);
  srv.close();
  bundle.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirS, { recursive: true, force: true });
});

test('HTTP: 拒绝非法 review_status', async () => {
  const { dir, dbPath } = bootstrap();
  const bundle = makeApiBundle(dbPath);
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-static-'));
  fs.writeFileSync(path.join(dirS, 'index.html'), '<html></html>');
  const { srv } = await startServer(bundle, dirS);
  const r = await fetchJson(srv, 'PATCH', '/api/candidates/faculty:fac-0',
    JSON.stringify({ review_status: 'wrong' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /invalid review_status/);
  srv.close();
  bundle.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirS, { recursive: true, force: true });
});

test('HTTP: 路径遍历阻断 /html/../etc/passwd', () => {
  assert.equal(serverMod.resolveSafeFile('/tmp/data', '../etc/passwd', 'html'), null);
  assert.equal(serverMod.resolveSafeFile('/tmp/data', 'a/../../etc/passwd', 'html'), null);
  assert.equal(serverMod.resolveSafeFile('/tmp/data', '', 'html'), null);
  assert.equal(serverMod.resolveSafeFile('/tmp/data', 'a/..\\b', 'html'), null);
  // 合法路径
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-pathsafe-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  const safe = serverMod.resolveSafeFile(dir, 'index.html', 'html');
  assert.ok(safe && safe.endsWith('index.html'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP: 解析 id 格式', () => {
  assert.deepEqual(serverMod.parseId('faculty:abc123'), { source: 'faculty', id: 'abc123' });
  assert.deepEqual(serverMod.parseId('paper:sha1:abc'), { source: 'paper', id: 'sha1:abc' });
  assert.equal(serverMod.parseId('bogus'), null);
  assert.equal(serverMod.parseId('wrong:'), null);
  assert.equal(serverMod.parseId(''), null);
});

module.exports = { tests };
