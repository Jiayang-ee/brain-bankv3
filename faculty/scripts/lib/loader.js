// loader.js — 读取 QS50 schools / departments 数据并提供便捷查询
// 依赖：内置 fs / path，不引入第三方包。
// 使用：
//   const { loadQs50 } = require('./lib/loader');
//   const { schools, departments, byRank } = loadQs50({ root: repoRoot });

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA_DIR = ['qs50', 'data'];

function resolveDataDir(root) {
  return path.join(root, ...DEFAULT_DATA_DIR);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`invalid JSON in ${filePath}: ${err.message}`);
    e.cause = err;
    throw e;
  }
}

function loadQs50({ root = process.cwd() } = {}) {
  const dataDir = resolveDataDir(root);
  const schoolsPath = path.join(dataDir, 'qs50_schools.json');
  const deptsPath = path.join(dataDir, 'qs50_departments.json');
  if (!fs.existsSync(schoolsPath)) {
    throw new Error(`missing ${schoolsPath}; run from repo root`);
  }
  if (!fs.existsSync(deptsPath)) {
    throw new Error(`missing ${deptsPath}; run from repo root`);
  }

  const schoolsDoc = readJson(schoolsPath);
  const deptsDoc = readJson(deptsPath);

  const schools = Array.isArray(schoolsDoc.schools) ? schoolsDoc.schools : [];
  const entries = Array.isArray(deptsDoc.entries) ? deptsDoc.entries : [];

  const byRank = new Map();
  for (const s of schools) byRank.set(s.rank, s);

  return {
    dataDir,
    schoolsPath,
    deptsPath,
    schools,
    departments: entries,
    meta: {
      schools: schoolsDoc.meta || null,
      departments: deptsDoc.meta || null,
    },
    byRank,
    byId: (departmentId) => entries.find((e) => e.department_id === departmentId),
    forRank: (rank) => entries.filter((e) => e.school_rank === rank),
  };
}

// 过滤活跃入口：valid / requires_js 都进入抓取队列；其它跳过并记日志
function activeEntries(loader) {
  return loader.departments.filter((e) => e.status === 'valid' || e.status === 'requires_js');
}

function isKnownCategory(category) {
  const allowed = new Set([
    'business_school', 'management_school',
    'engineering_management', 'industrial_engineering', 'systems_engineering',
    'operations_research', 'decision_science', 'information_systems',
    'business_analytics', 'public_policy',
  ]);
  return allowed.has(category);
}

module.exports = { loadQs50, activeEntries, isKnownCategory };
