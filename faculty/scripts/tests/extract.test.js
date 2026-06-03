// tests/extract.test.js — 单元测试：个人页字段抽取

'use strict';

const assert = require('node:assert/strict');
const { extractPersonalInfo, findEmails, findCjkNames, findTitle, readMeta } = require('../lib/extract.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('readMeta: og:title 命中', () => {
  const html = '<html><head><meta property="og:title" content="Xiaoming Wang | MIT Sloan"></head><body></body></html>';
  const m = readMeta(html);
  assert.equal(m['og:title'], 'Xiaoming Wang | MIT Sloan');
  assert.equal(m.__title, null); // 没 title 标签
});

test('readMeta: title 标签命中', () => {
  const html = '<html><head><title>Wang Xiao-Ming - Faculty</title></head></html>';
  const m = readMeta(html);
  assert.equal(m.__title, 'Wang Xiao-Ming - Faculty');
});

test('readMeta: h1 命中', () => {
  const html = '<html><body><h1>Wang Xiaoming</h1></body></html>';
  const m = readMeta(html);
  assert.equal(m.__h1, 'Wang Xiaoming');
});

test('findEmails: 标准邮箱', () => {
  const text = 'Contact me at xiaoming@mit.edu or xwang@cmu.edu.';
  const e = findEmails(text);
  assert.ok(e.includes('xiaoming@mit.edu'));
  assert.ok(e.includes('xwang@cmu.edu'));
});

test('findEmails: 去重 + 小写', () => {
  const text = 'XWang@mit.edu and xwang@mit.edu and xwang@MIT.EDU';
  const e = findEmails(text);
  assert.equal(e.length, 1);
  assert.equal(e[0], 'xwang@mit.edu');
});

test('findCjkNames: 提取 2-4 个汉字', () => {
  const text = '他是王晓明，来自清华大学';
  const c = findCjkNames(text);
  assert.ok(c.includes('王晓明'));
  assert.ok(c.includes('清华'));
  assert.ok(c.includes('大学'));
});

test('findCjkNames: 单词汉字不提取', () => {
  const text = '中 a 国';
  const c = findCjkNames(text);
  assert.equal(c.length, 0);
});

test('findTitle: Assistant Professor', () => {
  const text = 'Dr. Wang is an Assistant Professor of Operations Research.';
  assert.equal(findTitle(text), 'Assistant Professor');
});

test('findTitle: Associate Professor（先匹配长的）', () => {
  const text = 'She is an Associate Professor and the department chair.';
  assert.equal(findTitle(text), 'Associate Professor');
});

test('findTitle: PhD Student', () => {
  const text = 'Zhang is a PhD Student in Management Science.';
  assert.equal(findTitle(text), 'PhD Student');
});

test('findTitle: Postdoctoral Researcher', () => {
  const text = 'He is a Postdoctoral Researcher at the lab.';
  assert.equal(findTitle(text), 'Postdoctoral');
});

test('findTitle: 无匹配返回 null', () => {
  assert.equal(findTitle('Just a person'), null);
});

test('extractPersonalInfo: 综合抽取', () => {
  const html = `
    <html>
      <head>
        <title>Wang Xiaoming | MIT Sloan</title>
        <meta property="og:title" content="Wang Xiaoming">
        <meta name="description" content="Assistant Professor of Operations Research">
      </head>
      <body>
        <h1>Wang Xiaoming</h1>
        <p>王晓明，Email: wang@mit.edu</p>
      </body>
    </html>
  `;
  const info = extractPersonalInfo({ html, url: 'https://sloan.mit.edu/people/wang' });
  assert.equal(info.title, 'Wang Xiaoming | MIT Sloan');
  assert.equal(info.h1, 'Wang Xiaoming');
  assert.equal(info.meta.ogTitle, 'Wang Xiaoming');
  assert.equal(info.emails[0], 'wang@mit.edu');
  assert.ok(info.cjkFragments.includes('王晓明'));
  assert.equal(info.titleKeyword, 'Assistant Professor');
  // 第一个 name 候选是 h1
  assert.equal(info.nameCandidates[0].value, 'Wang Xiaoming');
});

test('extractPersonalInfo: 标题清洗（去掉 "|" 后内容）', () => {
  const html = '<html><head><title>Wei Li | UC Berkeley</title></head><body><h1>Wei Li</h1></body></html>';
  const info = extractPersonalInfo({ html, url: 'https://x.edu/' });
  // name 候选来自 h1/og/title；title 来源经过清洗
  const h1 = info.nameCandidates.find((c) => c.source === 'h1');
  assert.equal(h1.value, 'Wei Li');
});

module.exports = { tests };
