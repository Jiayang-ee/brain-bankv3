// tests/classify.test.js — 单元测试：列表页识别 + 链接抽取

'use strict';

const assert = require('node:assert/strict');
const { listUrlCandidates, scoreListPage, extractProfileLinks, extractInternalLinks, isProfileUrl, urlHasListToken } = require('../lib/classify.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('urlHasListToken: /people 命中', () => {
  assert.equal(urlHasListToken('https://example.edu/people'), true);
});

test('urlHasListToken: /about-us 不命中', () => {
  assert.equal(urlHasListToken('https://example.edu/about-us'), false);
});

test('listUrlCandidates: 入口 URL 是 /，生成多个候选', () => {
  const c = listUrlCandidates('https://sloan.mit.edu/');
  assert.ok(c.includes('https://sloan.mit.edu/'), 'entry URL included');
  assert.ok(c.includes('https://sloan.mit.edu/people'), 'people suffix included');
  assert.ok(c.includes('https://sloan.mit.edu/faculty'), 'faculty suffix included');
  assert.ok(c.length >= 5);
});

test('listUrlCandidates: 入口 URL 是 /mba/，生成多个候选', () => {
  const c = listUrlCandidates('https://www.hbs.edu/mba/');
  assert.ok(c.includes('https://www.hbs.edu/mba/'));
  assert.ok(c.includes('https://www.hbs.edu/mba/people'));
  assert.ok(c.includes('https://www.hbs.edu/people'));
});

test('listUrlCandidates: 入口 URL 已是 /people，直接命中', () => {
  const c = listUrlCandidates('https://cmu.edu/tepper/people');
  assert.ok(c[0] === 'https://cmu.edu/tepper/people');
});

test('extractInternalLinks: 同 host，去重', () => {
  const html = `
    <html><body>
      <a href="/a">A</a>
      <a href="/a">A again</a>
      <a href="https://cmu.edu/b">B</a>
      <a href="https://other.com/c">external</a>
      <a href="javascript:void(0)">js</a>
      <a href="mailto:x@y">mail</a>
    </body></html>
  `;
  const links = extractInternalLinks(html, 'https://cmu.edu/x');
  assert.ok(links.includes('https://cmu.edu/a'));
  assert.ok(links.includes('https://cmu.edu/b'));
  assert.equal(links.includes('https://other.com/c'), false);
  assert.equal(links.length, 2);
});

test('extractProfileLinks: 仅 /people/* 模式', () => {
  const html = `
    <a href="/people/wang">Wang</a>
    <a href="/about/team">Team</a>
    <a href="/people/zhang">Zhang</a>
  `;
  const links = extractProfileLinks(html, 'https://x.edu/');
  assert.equal(links.length, 2);
  assert.ok(links.some((u) => u.endsWith('/people/wang')));
});

test('scoreListPage: 含 /people token → 高分', () => {
  const html = '<html><head><title>People Directory</title></head><body><h1>Our People</h1></body></html>';
  const r = scoreListPage({ html, entryUrl: 'https://x.edu/people', profileLinkCount: 5 });
  assert.ok(r.score >= 0.5, `got ${r.score}`);
});

test('scoreListPage: 仅 1 个 internal link → 低分', () => {
  const html = '<html><body><a href="/x">x</a></body></html>';
  const r = scoreListPage({ html, entryUrl: 'https://x.edu/about', profileLinkCount: 0 });
  assert.ok(r.score < 0.5, `got ${r.score}`);
});

test('scoreListPage: 无 head 关键词 + 无 profile link → 极低分', () => {
  const html = '<html><head><title>Welcome</title></head><body><p>Hello</p></body></html>';
  const r = scoreListPage({ html, entryUrl: 'https://x.edu/', profileLinkCount: 0 });
  assert.ok(r.score < 0.3, `got ${r.score}`);
});

test('isProfileUrl: /people/wang → true', () => {
  assert.equal(isProfileUrl('https://x.edu/people/wang'), true);
});

test('isProfileUrl: /faculty/jones → true', () => {
  assert.equal(isProfileUrl('https://x.edu/faculty/jones'), true);
});

test('isProfileUrl: /research/publication → false', () => {
  assert.equal(isProfileUrl('https://x.edu/research/publication'), false);
});

module.exports = { tests };
