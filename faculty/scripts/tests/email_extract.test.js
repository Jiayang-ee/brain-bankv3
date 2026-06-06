// tests/email_extract.test.js — 单元测试：邮箱提取（BRA-9.1 path A + BRA-9.2 新增 enum）

'use strict';

const assert = require('node:assert/strict');

const {
  EMAIL_SOURCE_OPENALEX_REGEX,
  EMAIL_SOURCE_PUBLISHER_WILEY,
  EMAIL_SOURCE_PUBLISHER_ELSEVIER,
  EMAIL_SOURCE_ORCID_PUBLIC_API,
  EMAIL_SOURCE_MANUAL,
  VALID_SOURCES,
  REJECTED_DOMAINS,
  isValidEmail,
  extractEmailFromAffiliation,
  extractEmailForAuthor,
} = require('../lib/email_extract.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('isValidEmail: 标准邮箱 → true', () => {
  assert.equal(isValidEmail('foo@bar.edu'), true);
  assert.equal(isValidEmail('wang.xiaoming@tsinghua.edu.cn'), true);
  assert.equal(isValidEmail('a+tag@sub.example.co.uk'), true);
  assert.equal(isValidEmail('user_name@domain.com'), true);
});

test('isValidEmail: 缺 @ / 缺 domain → false', () => {
  assert.equal(isValidEmail('foo'), false);
  assert.equal(isValidEmail('foo@'), false);
  assert.equal(isValidEmail('foo@bar'), false);                  // 缺 TLD
  assert.equal(isValidEmail('@bar.com'), false);                  // 缺 local
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(undefined), false);
});

test('isValidEmail: 长度上限 / 纯数字 local → false', () => {
  const long = 'a'.repeat(250) + '@bar.com';
  assert.equal(isValidEmail(long), false);                       // > 254
  assert.equal(isValidEmail('1234567@bar.com'), false);          // 纯数字 local
  const longLocal = 'a'.repeat(65) + '@bar.com';
  assert.equal(isValidEmail(longLocal), false);                  // local > 64
});

test('isValidEmail: ISSN-like / URL-like / IP 域 → false', () => {
  assert.equal(isValidEmail('1234-5678@journal.com'), false);    // ISSN 前缀
  assert.equal(isValidEmail('12345678@journal.com'), false);     // 8 位纯数字 local
  assert.equal(isValidEmail('foo@http://bar.com'), false);       // URL 域
  assert.equal(isValidEmail('foo@192.168.1.1'), false);          // IP 域
  assert.equal(isValidEmail('foo@127.0.0.1'), false);
});

test('isValidEmail: 黑名单域 → false', () => {
  for (const d of REJECTED_DOMAINS) {
    assert.equal(isValidEmail(`user@${d}`), false, `expected reject ${d}`);
  }
});

test('VALID_SOURCES: 5 个枚举值且不重复（含 BRA-9.2 新增的 orcid_public_api）', () => {
  assert.equal(VALID_SOURCES.length, 5);
  assert.ok(VALID_SOURCES.includes(EMAIL_SOURCE_OPENALEX_REGEX));
  assert.ok(VALID_SOURCES.includes(EMAIL_SOURCE_PUBLISHER_WILEY));
  assert.ok(VALID_SOURCES.includes(EMAIL_SOURCE_PUBLISHER_ELSEVIER));
  assert.ok(VALID_SOURCES.includes(EMAIL_SOURCE_ORCID_PUBLIC_API));
  assert.ok(VALID_SOURCES.includes(EMAIL_SOURCE_MANUAL));
  assert.equal(new Set(VALID_SOURCES).size, 5);
});

test('EMAIL_SOURCE_ORCID_PUBLIC_API: 字面值 = "orcid_public_api"', () => {
  assert.equal(EMAIL_SOURCE_ORCID_PUBLIC_API, 'orcid_public_api');
  assert.ok(VALID_SOURCES.includes('orcid_public_api'));
});

test('extractEmailFromAffiliation: 典型 Corresponding author 命中', () => {
  const aff = 'Department of Surgical Oncology, Aster DM Healthcare, Bengaluru, Karnataka, India; Corresponding author: foo@bar.edu';
  const r = extractEmailFromAffiliation(aff);
  assert.ok(r);
  assert.equal(r.email, 'foo@bar.edu');
  assert.equal(r.source, EMAIL_SOURCE_OPENALEX_REGEX);
  assert.equal(r.confidence, 0.9);  // 含 Corresponding author → 高
  assert.ok(r.context.includes('Corresponding author'));
});

test('extractEmailFromAffiliation: 纯邮箱无 marker → 低 confidence', () => {
  const aff = 'MIT CSAIL, Cambridge, MA; contact: smith@mit.edu';
  const r = extractEmailFromAffiliation(aff);
  assert.ok(r);
  assert.equal(r.email, 'smith@mit.edu');
  assert.equal(r.confidence, 0.6);
});

test('extractEmailFromAffiliation: 拒绝 example.com 误命中', () => {
  const aff = 'Some Place, City; contact: test@example.com';
  const r = extractEmailFromAffiliation(aff);
  assert.equal(r, null);
});

test('extractEmailFromAffiliation: 拒绝 ISSN-like 邮箱', () => {
  const aff = 'A university; ISSN: 1234-5678@journal.foo';
  const r = extractEmailFromAffiliation(aff);
  assert.equal(r, null);
});

test('extractEmailFromAffiliation: 无邮箱 → null', () => {
  assert.equal(extractEmailFromAffiliation(null), null);
  assert.equal(extractEmailFromAffiliation(''), null);
  assert.equal(extractEmailFromAffiliation('Tsinghua University, Beijing'), null);
});

test('extractEmailFromAffiliation: 中文分号分隔', () => {
  const aff = '北京大学；通讯作者：zhang@pku.edu.cn';
  const r = extractEmailFromAffiliation(aff);
  assert.ok(r);
  assert.equal(r.email, 'zhang@pku.edu.cn');
});

test('extractEmailForAuthor: 多段 affiliation 优先取 Corresponding author 段', () => {
  const r = extractEmailForAuthor({
    author: {
      affiliation_raw:
        'Tsinghua University; wang@tsinghua.edu.cn; Corresponding author: li.wei@thu.edu',
    },
  });
  assert.ok(r);
  assert.equal(r.email, 'li.wei@thu.edu');
  assert.equal(r.confidence, 0.9);
});

test('extractEmailForAuthor: 多邮箱取第一个合法的', () => {
  const r = extractEmailForAuthor({
    author: { affiliation_raw: 'MIT CSAIL; alice@mit.edu; bob@mit.edu' },
  });
  assert.ok(r);
  // MIT 段无 Corresponding marker，两段都取自同一 affiliation，alice 先出现
  assert.equal(r.email, 'alice@mit.edu');
  assert.equal(r.confidence, 0.6);
});

test('extractEmailForAuthor: 无 affiliation_raw → null', () => {
  assert.equal(extractEmailForAuthor({ author: {} }), null);
  assert.equal(extractEmailForAuthor({ author: null }), null);
  assert.equal(extractEmailForAuthor({}), null);
});

test('extractEmailFromAffiliation: 截断 context 至 500 字符', () => {
  const longAff = 'X'.repeat(50) + ' ' + Array(20).fill('foo@bar.edu').join(' ') + ' ' + 'Y'.repeat(600);
  const r = extractEmailFromAffiliation(longAff);
  assert.ok(r);
  assert.ok(r.context.length <= 500);
});

module.exports = { tests };
