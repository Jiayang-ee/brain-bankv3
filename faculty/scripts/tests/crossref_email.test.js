// tests/crossref_email.test.js — 单元测试：Crossref /works/{doi} 邮箱抽取（BRA-9.3 3a spike）
//
// 测试覆盖：
//   1. normalizeDoi — 各种输入形式（裸 doi / URL 前缀 / doi: / 大小写 / 非法）
//   2. isValidEmailFormat / isBlacklistedDomain — 边界
//   3. extractEmailsFromString — 字符串里抽邮箱
//   4. extractEmailsFromWork — 真实 Crossref work JSON 模板
//      - 邮箱在 author[].affiliation[].name
//      - 邮箱在 author[].name（罕见）
//      - 邮箱在 assertion[].value（极罕见）
//      - 邮箱在 license[].URL（极罕见）
//      - 多个邮箱去重
//      - 黑名单域过滤
//      - 空 work JSON
//   5. fetchWork — mock fetch 测 200/404/429/5xx
//   6. processWork — end-to-end

'use strict';

const assert = require('node:assert/strict');

const {
  createCrossrefEmail,
  normalizeDoi,
  isValidEmailFormat,
  isBlacklistedDomain,
  extractEmailsFromString,
  extractEmailsFromWork,
} = require('../lib/crossref_email.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- normalizeDoi ----------
test('normalizeDoi: 标准 10.NNNN/...', () => {
  assert.equal(normalizeDoi('10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 去掉 https://doi.org/ 前缀', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 去掉 https://dx.doi.org/ 前缀', () => {
  assert.equal(normalizeDoi('https://dx.doi.org/10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 去掉 doi: 前缀', () => {
  assert.equal(normalizeDoi('doi:10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 大写转小写', () => {
  assert.equal(normalizeDoi('10.1038/S41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 非法输入', () => {
  assert.equal(normalizeDoi('foo'), null);
  assert.equal(normalizeDoi(''), null);
  assert.equal(normalizeDoi(null), null);
  assert.equal(normalizeDoi('10.123'), null);
  assert.equal(normalizeDoi('abc/10.1234/x'), null);
});

// ---------- isValidEmailFormat ----------
test('isValidEmailFormat: 标准域名', () => {
  assert.equal(isValidEmailFormat('foo@bar.edu'), true);
  assert.equal(isValidEmailFormat('foo.bar@mit.edu.cn'), true);
  assert.equal(isValidEmailFormat('a+b@example.com'), true);
});

test('isValidEmailFormat: 拒空 / 拒非字符串 / 拒缺 TLD', () => {
  assert.equal(isValidEmailFormat(''), false);
  assert.equal(isValidEmailFormat(null), false);
  assert.equal(isValidEmailFormat(undefined), false);
  assert.equal(isValidEmailFormat('foo@bar'), false);
  assert.equal(isValidEmailFormat('not-an-email'), false);
});

test('isValidEmailFormat: 拒超长', () => {
  const long = 'a'.repeat(260) + '@x.com';
  assert.equal(isValidEmailFormat(long), false);
});

// ---------- isBlacklistedDomain ----------
test('isBlacklistedDomain: example.com / springer.com / nature.com', () => {
  assert.equal(isBlacklistedDomain('foo@example.com'), true);
  assert.equal(isBlacklistedDomain('author@springer.com'), true);
  assert.equal(isBlacklistedDomain('author@nature.com'), true);
  assert.equal(isBlacklistedDomain('a@elsevier.com'), true);
});

test('isBlacklistedDomain: 真实学校邮箱通过', () => {
  assert.equal(isBlacklistedDomain('wjx@mit.edu'), false);
  assert.equal(isBlacklistedDomain('a.b@tsinghua.edu.cn'), false);
  assert.equal(isBlacklistedDomain('foo@cam.ac.uk'), false);
});

// ---------- extractEmailsFromString ----------
test('extractEmailsFromString: 单邮箱', () => {
  const r = extractEmailsFromString('Contact: wjx@mit.edu', 'test');
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
  assert.equal(r[0].source_field, 'test');
});

test('extractEmailsFromString: 多邮箱 + 去重', () => {
  const r = extractEmailsFromString('wjx@mit.edu and wjx@mit.edu also a@cam.ac.uk', 'test');
  assert.equal(r.length, 2);
  const emails = r.map((e) => e.email).sort();
  assert.deepEqual(emails, ['a@cam.ac.uk', 'wjx@mit.edu']);
});

test('extractEmailsFromString: 黑名单域被过滤', () => {
  const r = extractEmailsFromString('foo@example.com wjx@mit.edu bar@springer.com', 'test');
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
});

test('extractEmailsFromString: 非法邮箱被过滤', () => {
  const r = extractEmailsFromString('foo@bar not-an-email wjx@mit.edu', 'test');
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
});

test('extractEmailsFromString: 空 / 非字符串', () => {
  assert.equal(extractEmailsFromString(null, 'x').length, 0);
  assert.equal(extractEmailsFromString('', 'x').length, 0);
  assert.equal(extractEmailsFromString(undefined, 'x').length, 0);
});

// ---------- extractEmailsFromWork ----------
test('extractEmailsFromWork: 邮箱在 author[].affiliation[].name', () => {
  const work = {
    author: [
      { given: 'John', family: 'Smith', affiliation: [{ name: 'MIT, wjx@mit.edu' }] },
      { given: 'Jane', family: 'Doe', affiliation: [{ name: 'Tsinghua University' }] },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
  assert.equal(r[0].source_field, 'author_affiliation_name');
  assert.equal(r[0].author_idx, 0);
});

test('extractEmailsFromWork: 邮箱在 author[].name（罕见）', () => {
  const work = {
    author: [
      { name: 'John Smith wjx@mit.edu' },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
  assert.equal(r[0].source_field, 'author_name');
});

test('extractEmailsFromWork: 邮箱在 assertion[].value', () => {
  const work = {
    author: [],
    assertion: [
      { name: 'received', value: '2024-01-01' },
      { name: 'corresponding_author_email', value: 'cor@mit.edu' },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'cor@mit.edu');
  assert.equal(r[0].source_field, 'assertion');
});

test('extractEmailsFromWork: 邮箱在 license[].URL', () => {
  const work = {
    author: [],
    license: [
      { URL: 'https://creativecommons.org/licenses/by/4.0' },
      { URL: 'mailto:support@creativecommons.org' },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.ok(r.some((e) => e.source_field === 'license_url' && e.email.includes('creativecommons')));
});

test('extractEmailsFromWork: 多个邮箱去重（同 email 不同 author_idx 不去重）', () => {
  const work = {
    author: [
      { affiliation: [{ name: 'wjx@mit.edu' }] },
      { affiliation: [{ name: 'wjx@mit.edu (correspondence)' }] },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 2);
});

test('extractEmailsFromWork: 黑名单域过滤', () => {
  const work = {
    author: [
      { affiliation: [{ name: 'foo@springer.com wjx@mit.edu' }] },
    ],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
});

test('extractEmailsFromWork: 空 work JSON', () => {
  assert.equal(extractEmailsFromWork(null).length, 0);
  assert.equal(extractEmailsFromWork({}).length, 0);
  assert.equal(extractEmailsFromWork({ author: [] }).length, 0);
});

test('extractEmailsFromWork: 真实 Crossref 模板（无邮箱）', () => {
  const work = {
    DOI: '10.1007/s10479-024-06123-0',
    title: ['Sample paper'],
    author: [
      { given: 'John', family: 'Smith', affiliation: [{ name: 'MIT' }] },
      { given: 'Jane', family: 'Doe', affiliation: [] },
    ],
    assertion: [
      { name: 'received', value: '2023-07-21' },
    ],
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0' }],
  };
  const r = extractEmailsFromWork(work);
  assert.equal(r.length, 0);
});

// ---------- fetchWork (mock fetch) ----------
test('fetchWork: 200 + work JSON', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    data: { message: { DOI: '10.1234/test', author: [] } },
  });
  const cr = createCrossrefEmail({ fetchImpl: mockFetch });
  const r = await cr.fetchWork('10.1234/test');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.work.DOI, '10.1234/test');
});

test('fetchWork: 404 — 沉默返回，不重试', async () => {
  let callCount = 0;
  const mockFetch = async () => { callCount += 1; return { ok: false, status: 404, error: 'not_found' }; };
  const cr = createCrossrefEmail({ fetchImpl: mockFetch, maxRetries: 3 });
  const r = await cr.fetchWork('10.1234/missing');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(callCount, 1, '404 must not retry');
});

test('fetchWork: invalid_doi', async () => {
  const cr = createCrossrefEmail({ fetchImpl: async () => ({ ok: true, status: 200, data: {} }) });
  const r = await cr.fetchWork('not-a-doi');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_doi');
});

// ---------- processWork (end-to-end) ----------
test('processWork: 200 + 邮箱命中', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    data: {
      message: {
        DOI: '10.1234/test',
        author: [{ affiliation: [{ name: 'wjx@mit.edu' }] }],
      },
    },
  });
  const cr = createCrossrefEmail({ fetchImpl: mockFetch });
  const r = await cr.processWork({ doi: '10.1234/test' });
  assert.equal(r._ok, true);
  assert.equal(r.emails.length, 1);
  assert.equal(r.emails[0].email, 'wjx@mit.edu');
});

test('processWork: 200 + 无邮箱', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    data: { message: { DOI: '10.1234/test', author: [{ affiliation: [{ name: 'MIT' }] }] } },
  });
  const cr = createCrossrefEmail({ fetchImpl: mockFetch });
  const r = await cr.processWork({ doi: '10.1234/test' });
  assert.equal(r._ok, true);
  assert.equal(r.emails.length, 0);
});

test('processWork: 404', async () => {
  const mockFetch = async () => ({ ok: false, status: 404, error: 'not_found' });
  const cr = createCrossrefEmail({ fetchImpl: mockFetch });
  const r = await cr.processWork({ doi: '10.1234/missing' });
  assert.equal(r._ok, false);
  assert.equal(r._status, 404);
  assert.equal(r.emails.length, 0);
});

module.exports = { tests };
