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
    const dept = store.db.prepare('SELECT * FROM department_summary WHERE school_rank = ? AND department_id = ?').get(entry.school_rank, entry.department_id);
    assert.equal(dept.last_run_status, 'requires_js');
  }
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

module.exports = { tests };
