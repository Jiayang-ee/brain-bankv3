#!/usr/bin/env node
// validate.js — 校验 qs50_schools.json / qs50_departments.json 的结构与一致性
// 用法： node scripts/validate.js
// 退出码：0=通过；1=失败

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ALLOWED_CATEGORIES = new Set([
  'business_school', 'management_school',
  'engineering_management', 'industrial_engineering', 'systems_engineering',
  'operations_research', 'decision_science', 'information_systems',
  'business_analytics', 'public_policy',
]);
// v2.1: 任务 10 个方向必须全部出现在 category 字段中（PR #1 review fix）
const REQUIRED_CATEGORIES = new Set([
  'business_school', 'management_school',
  'engineering_management', 'industrial_engineering', 'systems_engineering',
  'operations_research', 'decision_science', 'information_systems',
  'business_analytics', 'public_policy',
]);
const ALLOWED_STATUS = new Set([
  'valid', 'requires_js', 'access_failed', 'suspected_irrelevant', 'requires_manual_confirmation',
]);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
}

(function main() {
  const schools = readJson('qs50_schools.json');
  const depts = readJson('qs50_departments.json');

  // ---- schools ----
  if (!Array.isArray(schools.schools) || schools.schools.length !== 50) {
    fail(`qs50_schools.json: schools length must be 50, got ${schools.schools?.length}`);
  }
  const ranks = new Set();
  for (const s of schools.schools || []) {
    if (typeof s.rank !== 'number' || s.rank < 1 || s.rank > 50) fail(`school rank out of range: ${s.rank}`);
    if (ranks.has(s.rank)) fail(`duplicate school rank: ${s.rank}`);
    ranks.add(s.rank);
    if (!s.name_en) fail(`school ${s.rank} missing name_en`);
    if (!s.country) fail(`school ${s.rank} missing country`);
  }
  if (ranks.size !== 50) fail(`expected 50 unique ranks, got ${ranks.size}`);

  // ---- departments ----
  if (!Array.isArray(depts.entries) || depts.entries.length < 50) {
    fail(`qs50_departments.json: entries length must be >= 50, got ${depts.entries?.length}`);
  }
  const seenKeys = new Set();
  const schoolRankInDepts = new Set();
  const seenCategories = new Set();
  for (const e of depts.entries || []) {
    if (!ranks.has(e.school_rank)) fail(`entry ${e.department_id} has unknown school_rank ${e.school_rank}`);
    schoolRankInDepts.add(e.school_rank);
    const key = `${e.school_rank}::${e.department_id}`;
    if (seenKeys.has(key)) fail(`duplicate key ${key}`);
    seenKeys.add(key);
    if (!e.url || !/^https?:\/\//.test(e.url)) fail(`entry ${key} url invalid: ${e.url}`);
    if (!ALLOWED_CATEGORIES.has(e.category)) fail(`entry ${key} category invalid: ${e.category}`);
    if (!ALLOWED_STATUS.has(e.status)) fail(`entry ${key} status invalid: ${e.status}`);
    if (typeof e.needs_js_hint !== 'boolean') fail(`entry ${key} needs_js_hint must be boolean`);
    seenCategories.add(e.category);
  }
  for (const r of ranks) {
    if (!schoolRankInDepts.has(r)) fail(`school rank ${r} has no department entry`);
  }

  // v2.1: 任务 10 个方向必须全部有 category 条目
  for (const c of REQUIRED_CATEGORIES) {
    if (!seenCategories.has(c)) fail(`required category missing in entries: ${c}`);
  }

  if (process.exitCode === 1) {
    console.error('\nVALIDATION FAILED');
  } else {
    console.log('VALIDATION OK');
    console.log(`- schools: ${schools.schools.length}`);
    console.log(`- departments: ${depts.entries.length}`);
    const status = {};
    for (const e of depts.entries) status[e.status] = (status[e.status] || 0) + 1;
    console.log(`- status distribution: ${JSON.stringify(status)}`);
    const cats = {};
    for (const e of depts.entries) cats[e.category] = (cats[e.category] || 0) + 1;
    console.log(`- category distribution: ${JSON.stringify(cats)}`);
    // 列出 10 个 required category 的最小集是否都 ≥ 1
    const required = [...REQUIRED_CATEGORIES].sort();
    const missing = required.filter(c => !(c in cats));
    if (missing.length === 0) {
      console.log(`- required category coverage: 10/10 (OK)`);
    } else {
      console.log(`- required category coverage: ${required.length - missing.length}/${required.length} (missing: ${missing.join(', ')})`);
    }
  }
})();
