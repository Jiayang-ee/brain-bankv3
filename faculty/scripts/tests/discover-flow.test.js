// tests/discover-flow.test.js — 端到端：dry-run 模式跑一遍主流程

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { parseArgs, processDepartment, pickEntries } = require('../discover.js');
const { loadQs50 } = require('../lib/loader.js');
const { createStore } = require('../lib/storage.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('parseArgs: 默认值', () => {
  const a = parseArgs(['node', 'discover.js']);
  assert.equal(a.dryRun, false);
  assert.equal(a.limit, 3);
  assert.equal(a.all, false);
});

test('parseArgs: --all --dry-run --out /tmp/foo', () => {
  const a = parseArgs(['node', 'discover.js', '--all', '--dry-run', '--out', '/tmp/foo']);
  assert.equal(a.all, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.out, '/tmp/foo');
});

test('parseArgs: --schools 1,7,20', () => {
  const a = parseArgs(['node', 'discover.js', '--schools', '1,7,20']);
  assert.deepEqual(a.schools, [1, 7, 20]);
});

test('parseArgs: --limit 5', () => {
  const a = parseArgs(['node', 'discover.js', '--limit', '5']);
  assert.equal(a.limit, 5);
});

test('pickEntries: --all → 全部', () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const a = parseArgs(['node', 'discover.js', '--all']);
  const e = pickEntries(loader, a);
  assert.ok(e.length >= 50, `got ${e.length}`);
});

test('pickEntries: --limit 1 → 每校 active 部门最多 1', () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const a = parseArgs(['node', 'discover.js', '--all', '--limit', '1']);
  const e = pickEntries(loader, a);
  // 只统计 active 部门；excluded 部门（如 Caltech）总是保留用于审计
  const counts = new Map();
  for (const x of e) {
    if (x._kind !== 'active') continue;
    counts.set(x.school_rank, (counts.get(x.school_rank) || 0) + 1);
  }
  for (const v of counts.values()) assert.equal(v, 1);
});

test('pickEntries: --limit 1 → excluded 部门保留', () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const a = parseArgs(['node', 'discover.js', '--all', '--limit', '1']);
  const e = pickEntries(loader, a);
  const excluded = e.filter((x) => x._kind === 'excluded');
  // Caltech 应该有 2 条 suspected_irrelevant
  assert.ok(excluded.length >= 2);
  const caltech = excluded.filter((x) => x.school_rank === 9);
  assert.equal(caltech.length, 2);
});

test('pickEntries: --schools 1,2,3', () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const a = parseArgs(['node', 'discover.js', '--all', '--schools', '1,2,3']);
  const e = pickEntries(loader, a);
  for (const x of e) assert.ok([1, 2, 3].includes(x.school_rank));
});

test('processDepartment: dry-run 模式产生候选', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const entry = loader.forRank(1).find((e) => e.department_id === 'mit-sloan');
  assert.ok(entry, 'mit-sloan entry must exist');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = {
    dryRun: true,
    dataDir,
    verbose: false,
    maxProfiles: 3,
  };
  const fetchImpl = async () => ({ ok: true, status: 200, body: Buffer.from(''), bytes: 0, durationMs: 0, redirectedTo: null });
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
  assert.equal(r.listOk, true);
  assert.ok(r.profileCount >= 1, `got ${r.profileCount}`);
  assert.ok(r.chineseCount >= 1, `chineseCount=${r.chineseCount}`);

  // 校验 db
  const candCount = store.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  assert.ok(candCount >= 2, `got ${candCount}`); // list_page + 至少 1 personal_page
  const dept = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = 1 AND department_id = ?').get('mit-sloan');
  assert.ok(dept);
  assert.equal(dept.last_run_status, 'ok');
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: needs_js_hint 跳过（无网络）', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  // MIT 的某些 entry 在数据中 needs_js_hint=true (清华) — 我们用 rank=20 清华测试
  const entry = loader.forRank(20).find((e) => e.status === 'requires_js') || loader.forRank(20)[0];
  // 如果没 requires_js 条目，跳过此测试
  if (!entry) return;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 1 };
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  if (entry.needs_js_hint) {
    const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
    assert.equal(r.listOk, false);
    assert.equal(r.skipped, true, 'requires_js 路径应置 skipped=true');
    assert.deepEqual(r.errors, [], 'requires_js 路径不应有 errors');
    const dept = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = ? AND department_id = ?').get(entry.school_rank, entry.department_id);
    assert.equal(dept.last_run_status, 'requires_js');
  }
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: excluded 入口不计入 failure', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  // Caltech 在 v2.1 数据里有 2 条 suspected_irrelevant
  const a = parseArgs(['node', 'discover.js', '--all']);
  const entries = pickEntries(loader, a);
  const excluded = entries.find((e) => e._kind === 'excluded');
  assert.ok(excluded, 'expected at least one excluded entry (Caltech)');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 1 };
  const fetchImpl = async () => { throw new Error('should not be called for excluded entry'); };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry: excluded, store, fetchImpl, rateLimit, log, opts });
  // 关键断言：excluded 入口走 skipped 路径，不算 failure
  assert.equal(r.skipped, true, `expected skipped=true, got ${JSON.stringify(r)}`);
  assert.equal(r.listOk, false);
  assert.deepEqual(r.errors, [], 'excluded 入口不应有 errors');
  // 部门汇总行应写为 skipped
  const dept = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = ? AND department_id = ?')
    .get(excluded.school_rank, excluded.department_id);
  assert.ok(dept);
  assert.equal(dept.last_run_status, 'skipped');
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: active 但无 list page → errors 计入 failure', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const entry = loader.forRank(1).find((e) => e.department_id === 'mit-sloan');
  assert.ok(entry);
  // 强制把 entry 标为 active 即可（forRank 拿到的就是 active）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 1 };
  // fetchImpl 永远失败，模拟 active 入口但 list 页面全部 404
  const fetchImpl = async () => ({ ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'forced 404' });
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
  assert.equal(r.skipped, false, 'active 入口走 no_list_page 不应算 skipped');
  assert.equal(r.listOk, false);
  assert.ok(r.errors.includes('no_list_page'), 'no_list_page 应记入 errors');
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- BRA-15 (v2.2) 端到端：URL hint + 清华 DMEI + MIT IDSS WP 404 ---

test('processDepartment: URL hint 优先命中（eth-dmtec / tsinghua-sem）', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  // 选 eth-dmtec
  const entry = loader.byId('eth-dmtec');
  assert.ok(entry, 'eth-dmtec entry must exist');
  assert.equal(entry.list_url_hint, 'https://mtec.ethz.ch/people.html', 'hint 应当出现在 v2.2 数据中（旧 /people/people.html 路径已 404，v2.2 followup 校准到当前 200 路径）');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 2 };

  // 记录 fetchImpl 被请求的 URL 顺序
  const requested = [];
  const fetchImpl = async (u) => {
    requested.push(u);
    if (u === entry.list_url_hint) {
      // 命中 hint → 返回含 list 链接的 HTML
      const html = `<html><head><title>D-MTEC People</title></head>
<body>
  <h1>People</h1>
  <ul>
    <li><a href="/people/jane-doe">Jane Doe</a> — Professor of Management</li>
    <li><a href="/people/john-smith">John Smith</a> — Senior Lecturer</li>
  </ul>
</body></html>`;
      return { ok: true, status: 200, body: Buffer.from(html, 'utf8'), bytes: html.length, durationMs: 5, redirectedTo: null };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'forced 404 for non-hint' };
  };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
  assert.equal(r.listOk, true, 'hint 命中应返回 listOk=true');
  assert.equal(r.listUrl, entry.list_url_hint, 'listUrl 应等于 hint');
  // 关键断言：hint 是 requested 的首个 URL
  assert.equal(requested[0], entry.list_url_hint, `hint 应被第一个请求；got ${requested[0]}`);
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: tsinghua-dmei 是 requires_manual_confirmation（不调用 fetcher）', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  // 用 pickEntries 走真实分流，确保 _kind=excluded 与 _kind=active 区分正确
  const a = parseArgs(['node', 'discover.js', '--all']);
  const entries = pickEntries(loader, a);
  const entry = entries.find((e) => e.school_rank === 20 && e.department_id === 'tsinghua-dmei');
  assert.ok(entry, 'tsinghua-dmei entry must be picked');
  assert.equal(entry.status, 'requires_manual_confirmation', 'v2.2 起改为 requires_manual_confirmation');
  assert.equal(entry._kind, 'excluded', 'pickEntries 应把非 active 入口标为 excluded');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 1 };
  // 任何 fetch 调用都应触发断言失败
  const fetchImpl = async () => { throw new Error('should not be called for requires_manual_confirmation'); };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
  // 关键断言：skipped 路径，不算 failure
  assert.equal(r.skipped, true);
  assert.equal(r.listOk, false);
  assert.deepEqual(r.errors, [], 'requires_manual_confirmation 不应有 errors');
  // 部门汇总行应写为 skipped
  const dept = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = ? AND department_id = ?')
    .get(entry.school_rank, entry.department_id);
  assert.ok(dept);
  assert.equal(dept.last_run_status, 'skipped');
  // 关键断言：没有 DNS 错误日志（crawl_log 中不应出现 dns_error）
  const dnsErrors = store.db.prepare("SELECT COUNT(*) AS n FROM crawl_log WHERE status = 'dns_error'").get().n;
  assert.equal(dnsErrors, 0, 'requires_manual_confirmation 不应产生 dns_error 日志');
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: MIT IDSS WordPress 404 模板 → name 退到 url_slug', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  // mit-idss-cm 是 active 入口，方便构造场景
  const entry = loader.byId('mit-idss-cm');
  assert.ok(entry, 'mit-idss-cm entry must exist');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-flow-'));
  const store = createStore({ dataDir, sqlite });
  const opts = { dryRun: false, dataDir, verbose: false, maxProfiles: 1 };

  // 模拟：list 页面正常返回 1 条 profile 链接；该 profile 返回 WP 404 模板
  const profileUrl = 'https://idss.mit.edu/people/victor-chernozhukov';
  const fetchImpl = async (u) => {
    if (u === entry.url || u === entry.list_url_hint) {
      const html = `<html><head><title>IDSS People</title></head><body>
<ul><li><a href="${profileUrl}">Victor</a></li></ul>
</body></html>`;
      return { ok: true, status: 200, body: Buffer.from(html, 'utf8'), bytes: html.length, durationMs: 5, redirectedTo: null };
    }
    if (u === profileUrl) {
      // WP 404 模板：HTTP 200，但 h1/og/author 全缺失，title="Not Found – IDSS"
      const html = `<html><head><title>Not Found &#8211; IDSS</title></head><body></body></html>`;
      return { ok: true, status: 200, body: Buffer.from(html, 'utf8'), bytes: html.length, durationMs: 5, redirectedTo: null };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'forced 404' };
  };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts });
  assert.equal(r.listOk, true);
  // 关键断言：name 不是 "Not Found"，而是从 URL slug 推出
  const row = store.db.prepare("SELECT * FROM candidates WHERE source_url = ?").get(profileUrl);
  assert.ok(row, 'candidate row should exist');
  assert.equal(row.name_raw, 'Victor Chernozhukov', `name_raw 应当是 url_slug 推出的姓名；got "${row.name_raw}"`);
  assert.notEqual(row.name_raw, 'Not Found', '绝不能把 "Not Found" 落库为姓名');
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- BRA-7.3 (v2.3)：--skip-existing 断点续跑 ---

test('parseArgs: --skip-existing', () => {
  const a = parseArgs(['node', 'discover.js', '--skip-existing']);
  assert.equal(a.skipExisting, true);
});

test('processDepartment: --skip-existing → 第二轮 personal_page URL 不重抓、不重写', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const entry = loader.forRank(1).find((e) => e.department_id === 'mit-sloan');
  assert.ok(entry);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-skip-'));
  const store = createStore({ dataDir, sqlite });

  // 第一次：dry-run 把 list_page 与 2 个 personal_page 写入 db
  const profileUrl1 = 'https://mitsloan.mit.edu/people/wang-xiaoming';
  const profileUrl2 = 'https://mitsloan.mit.edu/people/jane-doe';
  const listHtml = `<html><head><title>MIT Sloan People</title></head><body>
<ul>
  <li><a href="${profileUrl1}">Xiaoming Wang</a></li>
  <li><a href="${profileUrl2}">Jane Doe</a></li>
</ul>
</body></html>`;
  const profileHtml = (name) => `<html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`;
  const fetchImpl1 = async (u) => {
    if (u === entry.url) {
      return { ok: true, status: 200, body: Buffer.from(listHtml, 'utf8'), bytes: listHtml.length, durationMs: 1, redirectedTo: null };
    }
    if (u === profileUrl1) {
      return { ok: true, status: 200, body: Buffer.from(profileHtml('Xiaoming Wang'), 'utf8'), bytes: 100, durationMs: 1, redirectedTo: null };
    }
    if (u === profileUrl2) {
      return { ok: true, status: 200, body: Buffer.from(profileHtml('Jane Doe'), 'utf8'), bytes: 100, durationMs: 1, redirectedTo: null };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'forced 404' };
  };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  const opts1 = { dryRun: false, dataDir, verbose: false, maxProfiles: 5, skipExisting: false };
  const r1 = await processDepartment({ entry, store, fetchImpl: fetchImpl1, rateLimit, log, opts: opts1 });
  assert.equal(r1.listOk, true);
  assert.equal(r1.profileCount, 2);
  assert.equal(r1.skippedExisting, 0);

  const candidatesBefore = store.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  assert.ok(candidatesBefore >= 3, `first run should have list_page + 2 personal_page; got ${candidatesBefore}`);

  // 第二次：相同 store + skipExisting=true
  // 期望：list_page 仍被抓（用于发现新的 profile URL），但 2 个 personal_page 不再被抓
  const profileRequests2 = [];
  const fetchImpl2 = async (u) => {
    if (u === profileUrl1 || u === profileUrl2) {
      profileRequests2.push(u);
      throw new Error(`fetch should not be called for skip-existing profile URL: ${u}`);
    }
    if (u === entry.url) {
      return { ok: true, status: 200, body: Buffer.from(listHtml, 'utf8'), bytes: listHtml.length, durationMs: 1, redirectedTo: null };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'forced 404' };
  };
  const opts2 = { dryRun: false, dataDir, verbose: false, maxProfiles: 5, skipExisting: true };
  const r2 = await processDepartment({ entry, store, fetchImpl: fetchImpl2, rateLimit, log, opts: opts2 });
  assert.equal(r2.listOk, true, 'skip-existing 模式下 list page 仍需返回 listOk=true（list 页面本身较便宜，保留以发现新 profile URL）');
  assert.equal(r2.profileCount, 0, 'skip-existing 不应增加 profileCount');
  assert.equal(r2.skippedExisting, 2, `skippedExisting 应为 2（仅 personal_page）; got ${r2.skippedExisting}`);
  assert.equal(profileRequests2.length, 0, `skip-existing 不应触发 personal_page 的 fetch; called ${JSON.stringify(profileRequests2)}`);

  const candidatesAfter = store.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  assert.equal(candidatesAfter, candidatesBefore, `重跑后 candidates 行数应不变; before=${candidatesBefore} after=${candidatesAfter}`);

  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('processDepartment: --skip-existing → 上轮非 success 的 URL 仍会被重抓', async () => {
  const loader = loadQs50({ root: REPO_ROOT });
  const entry = loader.forRank(1).find((e) => e.department_id === 'mit-sloan');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-skip2-'));
  const store = createStore({ dataDir, sqlite });

  const profileUrl = 'https://mitsloan.mit.edu/people/wang';
  const listHtml = `<html><head><title>People</title></head><body>
<ul><li><a href="${profileUrl}">Wang</a></li></ul></body></html>`;
  // 第一次：profile 返回 200（记入 candidates + crawl_log）
  // 然后手动把该 row 的 crawl_status 改成 'http_error' 模拟"上轮抓失败"
  const profileHtml = '<html><body><h1>Wang</h1></body></html>';
  const fetchImpl1 = async (u) => {
    if (u === entry.url) return { ok: true, status: 200, body: Buffer.from(listHtml, 'utf8'), bytes: listHtml.length, durationMs: 1, redirectedTo: null };
    if (u === profileUrl) return { ok: true, status: 200, body: Buffer.from(profileHtml, 'utf8'), bytes: profileHtml.length, durationMs: 1, redirectedTo: null };
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1 };
  };
  const rateLimit = async () => undefined;
  const log = () => undefined;
  await processDepartment({ entry, store, fetchImpl: fetchImpl1, rateLimit, log, opts: { dryRun: false, dataDir, verbose: false, maxProfiles: 5, skipExisting: false } });
  // 模拟"上轮失败"：直接把该行 crawl_status 改成 http_error
  store.db.prepare("UPDATE candidates SET crawl_status = 'http_error' WHERE source_kind = 'personal_page' AND source_url = ?").run(profileUrl);
  assert.equal(store.getCandidateStatus('personal_page', profileUrl), 'http_error');

  // 第二次：profile 200 → 应被重新抓取（因为上轮非 success）
  let profileFetchedAgain = false;
  const fetchImpl2 = async (u) => {
    if (u === entry.url) return { ok: true, status: 200, body: Buffer.from(listHtml, 'utf8'), bytes: listHtml.length, durationMs: 1, redirectedTo: null };
    if (u === profileUrl) {
      profileFetchedAgain = true;
      return { ok: true, status: 200, body: Buffer.from(profileHtml, 'utf8'), bytes: profileHtml.length, durationMs: 1, redirectedTo: null };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1 };
  };
  const r2 = await processDepartment({ entry, store, fetchImpl: fetchImpl2, rateLimit, log, opts: { dryRun: false, dataDir, verbose: false, maxProfiles: 5, skipExisting: true } });
  assert.equal(r2.skippedExisting, 0, '上轮非 success 的 profile URL 不应被 skip');
  assert.equal(profileFetchedAgain, true, '上轮非 success 的 profile URL 应被重新抓取');
  assert.equal(store.getCandidateStatus('personal_page', profileUrl), 'success');

  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

module.exports = { tests };
