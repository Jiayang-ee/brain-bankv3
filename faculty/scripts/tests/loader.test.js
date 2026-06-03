// tests/loader.test.js — 单元测试：QS50 数据加载

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { loadQs50, activeEntries, isKnownCategory } = require('../lib/loader.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('loadQs50: 加载 schools + departments', () => {
  const r = loadQs50({ root: REPO_ROOT });
  assert.equal(r.schools.length, 50);
  assert.ok(r.departments.length >= 50);
  assert.ok(r.byRank.get(1));
  assert.equal(r.byRank.get(1).name_en.startsWith('Massachusetts'), true);
});

test('loadQs50: byId 找到指定部门', () => {
  const r = loadQs50({ root: REPO_ROOT });
  const e = r.byId('mit-sloan');
  assert.ok(e);
  assert.equal(e.school_rank, 1);
  assert.equal(e.category, 'business_school');
});

test('loadQs50: forRank 返回该校所有部门', () => {
  const r = loadQs50({ root: REPO_ROOT });
  const list = r.forRank(1);
  assert.ok(list.length >= 1);
  assert.ok(list.every((e) => e.school_rank === 1));
});

test('activeEntries: 包含 valid 与 requires_js，排除其它', () => {
  const r = loadQs50({ root: REPO_ROOT });
  const active = activeEntries(r);
  // 不应包含 suspected_irrelevant (Caltech)
  const caltech = active.filter((e) => e.school_rank === 9);
  assert.equal(caltech.length, 0);
});

test('isKnownCategory: 合法值', () => {
  assert.equal(isKnownCategory('business_school'), true);
  assert.equal(isKnownCategory('public_policy'), true);
  assert.equal(isKnownCategory('invalid'), false);
});

module.exports = { tests };
