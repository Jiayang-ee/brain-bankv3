// tests/openaire_email.test.js — 单元测试：OpenAIRE /search/researchProducts 邮箱抽取（BRA-9.3 3a spike）
//
// 测试覆盖：
//   1. normalizeDoi — 与 crossref_email 类似的边界
//   2. isValidEmailFormat / isBlacklistedDomain
//   3. extractEmailsFromString
//   4. extractEmailsFromJson — OpenAIRE 真实 JSON 模板
//      - 邮箱在 creator 的 email 字段
//      - 邮箱在 contact 节点
//      - 邮箱在任意 string 字段
//      - 去重 + 黑名单域
//      - 空 JSON
//   5. fetchByDoi / processDoi — mock fetch

'use strict';

const assert = require('node:assert/strict');

const {
  createOpenaireEmail,
  normalizeDoi,
  isValidEmailFormat,
  isBlacklistedDomain,
  extractEmailsFromString,
  extractEmailsFromJson,
} = require('../lib/openaire_email.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- normalizeDoi ----------
test('normalizeDoi: 标准 10.NNNN/...', () => {
  assert.equal(normalizeDoi('10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
  assert.equal(normalizeDoi('doi:10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2');
});

test('normalizeDoi: 非法', () => {
  assert.equal(normalizeDoi('foo'), null);
  assert.equal(normalizeDoi(''), null);
  assert.equal(normalizeDoi(null), null);
  assert.equal(normalizeDoi('10.123'), null);
});

// ---------- isValidEmailFormat ----------
test('isValidEmailFormat: 标准 / 拒空 / 拒缺 TLD', () => {
  assert.equal(isValidEmailFormat('wjx@mit.edu'), true);
  assert.equal(isValidEmailFormat('a@x.io'), true);
  assert.equal(isValidEmailFormat(''), false);
  assert.equal(isValidEmailFormat('foo@bar'), false);
});

// ---------- isBlacklistedDomain ----------
test('isBlacklistedDomain: openaire.eu / example.com / github.com / academia.edu', () => {
  assert.equal(isBlacklistedDomain('a@openaire.eu'), true);
  assert.equal(isBlacklistedDomain('a@example.com'), true);
  assert.equal(isBlacklistedDomain('a@github.com'), true);
  assert.equal(isBlacklistedDomain('a@academia.edu'), true);
  assert.equal(isBlacklistedDomain('a@researchgate.net'), true);
  assert.equal(isBlacklistedDomain('a@mit.edu'), false);
});

// ---------- extractEmailsFromString ----------
test('extractEmailsFromString: 单邮箱', () => {
  const r = extractEmailsFromString('Contact: wjx@mit.edu', 'test');
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
});

test('extractEmailsFromString: 黑名单过滤', () => {
  const r = extractEmailsFromString('wjx@openaire.eu a@mit.edu', 'test');
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'a@mit.edu');
});

// ---------- extractEmailsFromJson ----------
test('extractEmailsFromJson: 邮箱在 creator.email 字段', () => {
  const json = {
    response: {
      results: {
        result: [
          {
            metadata: {
              'oaf:entity': {
                'oaf:result': {
                  creator: [
                    { '@rank': '1', '@name': 'John', '@surname': 'Smith', '@email': 'john@mit.edu' },
                    { '@rank': '2', '@name': 'Jane', '@surname': 'Doe' },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = extractEmailsFromJson(json);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'john@mit.edu');
  assert.equal(r[0].source_field, 'field:@email');
});

test('extractEmailsFromJson: 邮箱在 contact 节点', () => {
  const json = {
    response: {
      results: {
        result: [
          {
            metadata: {
              'oaf:entity': {
                'oaf:result': {
                  contact: { email: 'contact@cam.ac.uk' },
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = extractEmailsFromJson(json);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'contact@cam.ac.uk');
  assert.equal(r[0].source_field, 'field:email');
});

test('extractEmailsFromJson: 邮箱在 string 字段里（兜底）', () => {
  const json = {
    response: {
      results: {
        result: [
          {
            metadata: {
              'oaf:entity': {
                'oaf:result': {
                  description: 'Contact: wjx@mit.edu for correspondence',
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = extractEmailsFromJson(json);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'wjx@mit.edu');
  assert.equal(r[0].source_field, 'openaire');
});

test('extractEmailsFromJson: 多邮箱 + 去重', () => {
  const json = {
    response: {
      results: {
        result: [
          {
            metadata: {
              'oaf:entity': {
                'oaf:result': {
                  creator: [
                    { '@email': 'a@mit.edu' },
                    { '@email': 'a@mit.edu' },
                    { '@email': 'b@cam.ac.uk' },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = extractEmailsFromJson(json);
  assert.equal(r.length, 2);
  const emails = r.map((e) => e.email).sort();
  assert.deepEqual(emails, ['a@mit.edu', 'b@cam.ac.uk']);
});

test('extractEmailsFromJson: 空 JSON', () => {
  assert.equal(extractEmailsFromJson(null).length, 0);
  assert.equal(extractEmailsFromJson({}).length, 0);
  assert.equal(extractEmailsFromJson({ response: { results: { result: [] } } }).length, 0);
});

test('extractEmailsFromJson: 真实 OpenAIRE 模板（无邮箱）', () => {
  const json = {
    response: {
      results: {
        result: [
          {
            metadata: {
              'oaf:entity': {
                'oaf:result': {
                  creator: [
                    { '@rank': '1', '@name': 'John', '@surname': 'Jumper', '@orcid_pending': '0000-0001-6169-6580', '$': 'John Jumper' },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = extractEmailsFromJson(json);
  assert.equal(r.length, 0);
});

// ---------- fetchByDoi / processDoi ----------
test('fetchByDoi: 200 + JSON', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    data: { response: { results: { result: [] } } },
  });
  const oe = createOpenaireEmail({ fetchImpl: mockFetch });
  const r = await oe.fetchByDoi('10.1038/s41586-021-03819-2');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
});

test('fetchByDoi: 404 — 不重试', async () => {
  let callCount = 0;
  const mockFetch = async () => { callCount += 1; return { ok: false, status: 404, error: 'not_found' }; };
  const oe = createOpenaireEmail({ fetchImpl: mockFetch, maxRetries: 3 });
  const r = await oe.fetchByDoi('10.1234/missing');
  assert.equal(r.ok, false);
  assert.equal(callCount, 1);
});

test('fetchByDoi: invalid_doi', async () => {
  const oe = createOpenaireEmail({ fetchImpl: async () => ({ ok: true, status: 200, data: {} }) });
  const r = await oe.fetchByDoi('not-a-doi');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_doi');
});

test('processDoi: 200 + creator.email 命中', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    data: {
      response: {
        results: {
          result: [
            {
              metadata: {
                'oaf:entity': {
                  'oaf:result': {
                    creator: [{ '@email': 'wjx@mit.edu' }],
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const oe = createOpenaireEmail({ fetchImpl: mockFetch });
  const r = await oe.processDoi({ doi: '10.1234/test' });
  assert.equal(r._ok, true);
  assert.equal(r.emails.length, 1);
  assert.equal(r.emails[0].email, 'wjx@mit.edu');
});

module.exports = { tests };
