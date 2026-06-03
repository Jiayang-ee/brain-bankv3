// tests/files.test.js — 单元测试：本地文件路径

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { slugify, schoolSlug, urlHash, htmlRelPath, writeArchive, relToPosix } = require('../lib/files.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('slugify: 简单字符串', () => {
  assert.equal(slugify('MIT Sloan School of Management'), 'mit-sloan-school-of-management');
});

test('slugify: 特殊字符替换', () => {
  assert.equal(slugify('A & B / C!'), 'a-and-b-c');
});

test('slugify: 中日韩保留 → unknown', () => {
  // slugify 不支持中文 → unknown
  assert.equal(slugify('清华大学'), 'unknown');
});

test('slugify: 空字符串 → unknown', () => {
  assert.equal(slugify(''), 'unknown');
});

test('schoolSlug: 含 rank padding', () => {
  assert.equal(schoolSlug(1, 'MIT'), 'qs-01-mit');
  assert.equal(schoolSlug(50, 'LMU Munich'), 'qs-50-lmu-munich');
});

test('urlHash: 同 URL 同 hash', () => {
  const a = urlHash('https://x.edu/people/wang');
  const b = urlHash('https://x.edu/people/wang');
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('urlHash: 不同 URL 不同 hash', () => {
  const a = urlHash('https://x.edu/people/wang');
  const b = urlHash('https://x.edu/people/li');
  assert.notEqual(a, b);
});

test('htmlRelPath: list_page', () => {
  const p = htmlRelPath({ schoolRank: 1, schoolName: 'MIT', departmentId: 'mit-sloan', kind: 'list_page', sourceUrl: 'https://mitsloan.mit.edu/people', indexHint: 0 });
  assert.equal(p, 'html/qs-01-mit/mit-sloan/list/00.html');
});

test('htmlRelPath: personal_page', () => {
  const p = htmlRelPath({ schoolRank: 1, schoolName: 'MIT', departmentId: 'mit-sloan', kind: 'personal_page', sourceUrl: 'https://mitsloan.mit.edu/people/wang' });
  const expectedHash = urlHash('https://mitsloan.mit.edu/people/wang');
  assert.equal(p, `html/qs-01-mit/mit-sloan/people/${expectedHash}/index.html`);
});

test('htmlRelPath: 错误 kind 抛错', () => {
  assert.throws(() => htmlRelPath({ schoolRank: 1, schoolName: 'MIT', departmentId: 'd', kind: 'invalid' }));
});

test('writeArchive: 实际写盘 + 读回', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-files-'));
  const r = writeArchive({
    fs,
    dataDir: tmp,
    schoolRank: 1,
    schoolName: 'MIT',
    departmentId: 'mit-sloan',
    kind: 'list_page',
    sourceUrl: 'https://mitsloan.mit.edu/people',
    body: Buffer.from('<html></html>'),
    indexHint: 0,
  });
  assert.ok(fs.existsSync(r.absPath));
  const back = fs.readFileSync(r.absPath, 'utf8');
  assert.equal(back, '<html></html>');
  assert.equal(r.relPath, 'html/qs-01-mit/mit-sloan/list/00.html');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('relToPosix: 跨平台', () => {
  if (path.sep === '/') {
    assert.equal(relToPosix('a/b/c'), 'a/b/c');
  } else {
    assert.equal(relToPosix('a\\b\\c'), 'a/b/c');
  }
});

module.exports = { tests };
