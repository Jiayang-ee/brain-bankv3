// tests/extract.test.js — 单元测试：个人页字段抽取

'use strict';

const assert = require('node:assert/strict');
const { extractPersonalInfo, findEmails, findCjkNames, findTitle, readMeta, isNotFoundName, parseNameFromTitle, nameFromUrlSlug, pickBestName } = require('../lib/extract.js');

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

// --- BRA-15 (v2.2) 姓名兜底 ---

test('isNotFoundName: 各种 NOT_FOUND 模式', () => {
  assert.equal(isNotFoundName('Not Found'), true);
  assert.equal(isNotFoundName('  not found  '), true);
  assert.equal(isNotFoundName('not_found'), true);
  assert.equal(isNotFoundName('Page Not Found'), true);
  assert.equal(isNotFoundName('page-not-found'), true);
  assert.equal(isNotFoundName('404'), true);
  assert.equal(isNotFoundName('Error 404'), true);
  assert.equal(isNotFoundName('Error'), true);
  assert.equal(isNotFoundName('Missing'), true);
  assert.equal(isNotFoundName('Unknown'), true);
  assert.equal(isNotFoundName(''), true);
  assert.equal(isNotFoundName(null), true);
  assert.equal(isNotFoundName(undefined), true);
  // 真姓名不应被误判
  assert.equal(isNotFoundName('Victor Chernozhukov'), false);
  assert.equal(isNotFoundName('王晓明'), false);
  assert.equal(isNotFoundName('Wei Li'), false);
});

test('parseNameFromTitle: 去掉院系后缀', () => {
  assert.equal(parseNameFromTitle('Victor Chernozhukov – IDSS'), 'Victor Chernozhukov');
  assert.equal(parseNameFromTitle('Wei Li | UC Berkeley'), 'Wei Li');
  assert.equal(parseNameFromTitle('王晓明 · 清华大学'), '王晓明');
  assert.equal(parseNameFromTitle('Jane Smith, PhD'), 'Jane Smith');
});

test('parseNameFromTitle: NOT_FOUND 模板返回 null', () => {
  assert.equal(parseNameFromTitle('Not Found – IDSS'), null);
  assert.equal(parseNameFromTitle('Page Not Found'), null);
  assert.equal(parseNameFromTitle('404 – Department'), null);
  assert.equal(parseNameFromTitle('Not Found'), null);
});

test('parseNameFromTitle: 空白 / null / undefined 防御', () => {
  assert.equal(parseNameFromTitle(null), null);
  assert.equal(parseNameFromTitle(undefined), null);
  assert.equal(parseNameFromTitle('   '), null);
});

test('nameFromUrlSlug: 个人页 slug → Title-case', () => {
  assert.equal(nameFromUrlSlug('https://idss.mit.edu/people/victor-chernozhukov'), 'Victor Chernozhukov');
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/tepper/people/jane-doe'), 'Jane Doe');
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/tepper/people/jane_doe_smith'), 'Jane Doe Smith');
});

test('nameFromUrlSlug: 列表页 slug → null（避免误投）', () => {
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/tepper/people'), null);
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/tepper/people/'), null);
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/tepper/team'), null);
  assert.equal(nameFromUrlSlug('https://www.cmu.edu/research/'), null);
});

test('nameFromUrlSlug: 防御（null / 非法 URL / 短 slug）', () => {
  assert.equal(nameFromUrlSlug(null), null);
  assert.equal(nameFromUrlSlug(''), null);
  assert.equal(nameFromUrlSlug('not a url'), null);
  assert.equal(nameFromUrlSlug('https://idss.mit.edu/people/ab'), null);
});

test('pickBestName: h1 优先', () => {
  const m = { __h1: 'Wang Xiaoming', __title: 'Wang Xiaoming | MIT', 'og:title': 'Wang', author: 'Wang Xiaoming' };
  const r = pickBestName({ meta: m, url: 'https://x.edu/people/wang' });
  assert.equal(r.value, 'Wang Xiaoming');
  assert.equal(r.source, 'h1');
});

test('pickBestName: og:title 第二（h1 缺失时）', () => {
  const m = { __h1: null, __title: 'Wang Xiaoming | MIT', 'og:title': 'Wang Xiaoming', author: 'Wang' };
  const r = pickBestName({ meta: m, url: 'https://x.edu/people/wang' });
  assert.equal(r.value, 'Wang Xiaoming');
  assert.equal(r.source, 'og:title');
});

test('pickBestName: title_cleaned 兜底（h1/og/author 全缺失 + title 不是 NOT_FOUND）', () => {
  const m = { __h1: null, __title: 'Victor Chernozhukov – IDSS', 'og:title': null, author: null };
  const r = pickBestName({ meta: m, url: 'https://idss.mit.edu/people/victor-chernozhukov' });
  assert.equal(r.value, 'Victor Chernozhukov');
  assert.equal(r.source, 'title_cleaned');
});

test('pickBestName: MIT IDSS WordPress 404 模板 → url_slug', () => {
  // BRA-15 触发场景：h1/og/author 全缺失，title 是 "Not Found" 模板
  const m = { __h1: null, __title: 'Not Found – IDSS', 'og:title': null, author: null };
  const r = pickBestName({ meta: m, url: 'https://idss.mit.edu/people/victor-chernozhukov' });
  assert.equal(r.value, 'Victor Chernozhukov');
  assert.equal(r.source, 'url_slug');
});

test('pickBestName: NOT_FOUND + 列表页 URL → 仍 null（不强行产出姓名）', () => {
  const m = { __h1: null, __title: 'Not Found – IDSS', 'og:title': null, author: null };
  const r = pickBestName({ meta: m, url: 'https://idss.mit.edu/people/' });
  assert.equal(r.value, null);
  assert.equal(r.source, null);
});

test('pickBestName: NOT_FOUND + 无 token URL → null', () => {
  const m = { __h1: null, __title: 'Not Found', 'og:title': null, author: null };
  const r = pickBestName({ meta: m, url: 'https://x.edu/' });
  assert.equal(r.value, null);
  assert.equal(r.source, null);
});

test('pickBestName: h1 也是 NOT_FOUND → 跳过 → 退到 title/url', () => {
  const m = { __h1: 'Not Found', __title: 'Not Found – IDSS', 'og:title': null, author: null };
  const r = pickBestName({ meta: m, url: 'https://idss.mit.edu/people/jane-doe' });
  assert.equal(r.value, 'Jane Doe');
  assert.equal(r.source, 'url_slug');
});

module.exports = { tests };
