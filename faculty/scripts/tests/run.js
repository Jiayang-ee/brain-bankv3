#!/usr/bin/env node
// tests/run.js — 单元测试入口（无第三方依赖，纯 node:assert）。
// 用法： node faculty/scripts/tests/run.js
// 退出码：0=全部通过；1=有失败

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const testFiles = [
  './chinese.test.js',
  './classify.test.js',
  './extract.test.js',
  './files.test.js',
  './loader.test.js',
  './storage.test.js',
  './discover-flow.test.js',
  './photos.test.js',
  './photos-flow.test.js',
  './papers_csv.test.js',
  './paper_extract.test.js',
  './papers_flow.test.js',
  './email_extract.test.js',
  './orcid_enrich.test.js',
];

let totalRun = 0;
let totalFailed = 0;
const failures = [];

async function runFile(file) {
  const mod = require(path.join(__dirname, file));
  for (const t of mod.tests) {
    totalRun += 1;
    try {
      await t.fn(assert);
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      totalFailed += 1;
      failures.push({ file, name: t.name, err });
      console.error(`  ✗ ${t.name}\n      ${err.message}`);
    }
  }
}

(async () => {
  for (const f of testFiles) {
    if (!fs.existsSync(path.join(__dirname, f))) {
      console.error(`[skip] ${f} not found`);
      continue;
    }
    console.log(`\n# ${f}`);
    await runFile(f);
  }
  console.log(`\n${totalRun} tests, ${totalFailed} failed`);
  if (totalFailed > 0) {
    for (const f of failures) {
      console.error(`  - ${f.file} :: ${f.name}\n    ${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  }
})();
