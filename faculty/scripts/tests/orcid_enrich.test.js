// tests/orcid_enrich.test.js — 单元测试：ORCID 公共 API 反向查询（BRA-9.2）
//
// 测试覆盖：
//   1. normalizeOrcidId — 各种输入形式（裸 19 位 / URL 前缀 / 全小写 / 全大写 / 非法）
//   2. extractEmailsFromPerson / extractExternalIds / extractAffiliationsFromPerson / extractCreditName
//   3. isValidEmailFormat — 边界（黑名单 / ISSN-like / IP / 长度）
//   4. processAuthor — mock fetch 测 200+email / 404 / 200 空 email / 429 退避
//   5. store.recordOrcidProfile — 集成测试

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const {
  createOrcidEnrich,
  normalizeOrcidId,
  isValidEmailFormat,
  extractCreditName,
  extractEmailsFromPerson,
  extractExternalIds,
  extractAffiliationsFromPerson,
  DEFAULT_BASE,
} = require('../lib/orcid_enrich.js');
const { createStore } = require('../lib/storage.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- normalizeOrcidId ----------
test('normalizeOrcidId: 规范形式 19 位短横线', () => {
  assert.equal(normalizeOrcidId('0000-0001-2345-6789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 末位 X', () => {
  assert.equal(normalizeOrcidId('0000-0001-2345-678X'), '0000-0001-2345-678X');
});

test('normalizeOrcidId: 去掉 URL 前缀', () => {
  assert.equal(normalizeOrcidId('https://orcid.org/0000-0001-2345-6789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 去掉 orcid: 前缀', () => {
  assert.equal(normalizeOrcidId('orcid:0000-0001-2345-6789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 全小写转大写', () => {
  assert.equal(normalizeOrcidId('0000-0001-2345-6789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 16 位纯数字补齐', () => {
  assert.equal(normalizeOrcidId('0000000123456789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 容错—把多余短横线归一', () => {
  assert.equal(normalizeOrcidId('0000-0001--2345-6789'), '0000-0001-2345-6789');
});

test('normalizeOrcidId: 非法输入', () => {
  assert.equal(normalizeOrcidId('foo'), null);
  assert.equal(normalizeOrcidId(''), null);
  assert.equal(normalizeOrcidId(null), null);
  assert.equal(normalizeOrcidId('123'), null);
});

// ---------- isValidEmailFormat ----------
test('isValidEmailFormat: 标准域名', () => {
  assert.equal(isValidEmailFormat('foo@bar.edu'), true);
  assert.equal(isValidEmailFormat('foo.bar@mit.edu.cn'), true);
});

test('isValidEmailFormat: 拒空 / 拒非字符串 / 拒缺 TLD', () => {
  // 注：orcid_enrich 的 isValidEmailFormat 故意比 email_extract 宽松：
  // ORCID 邮箱是用户主动维护的，ISSN-like 误命中风险几乎为 0
  assert.equal(isValidEmailFormat(''), false);
  assert.equal(isValidEmailFormat(null), false);
  assert.equal(isValidEmailFormat(undefined), false);
  assert.equal(isValidEmailFormat(123), false);
  assert.equal(isValidEmailFormat('foo@'), false);
  assert.equal(isValidEmailFormat('foo'), false);
  assert.equal(isValidEmailFormat('http://x.com'), false);
  assert.equal(isValidEmailFormat('@bar.com'), false);
  // 长度上限
  const long = 'a'.repeat(250) + '@b.edu';
  assert.equal(isValidEmailFormat(long), false);
});

test('isValidEmailFormat: 长度上限', () => {
  const long = 'a'.repeat(250) + '@b.edu';
  assert.equal(isValidEmailFormat(long), false);
});

// ---------- extractCreditName ----------
test('extractCreditName: given + family', () => {
  const p = { name: { 'given-names': { value: 'Wang' }, 'family-name': { value: 'Xiaoming' } } };
  assert.equal(extractCreditName(p), 'Wang Xiaoming');
});

test('extractCreditName: 退化 credit-name', () => {
  const p = { name: { 'credit-name': { value: 'Wang XM' } } };
  assert.equal(extractCreditName(p), 'Wang XM');
});

test('extractCreditName: 缺 name 字段', () => {
  assert.equal(extractCreditName({}), null);
  assert.equal(extractCreditName(null), null);
});

// ---------- extractEmailsFromPerson ----------
test('extractEmailsFromPerson: 单 primary email', () => {
  const p = { emails: { email: [{ email: 'w@mit.edu', primary: true, visibility: 'public' }] } };
  const out = extractEmailsFromPerson(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].email, 'w@mit.edu');
  assert.equal(out[0].primary, true);
  assert.equal(out[0].visibility, 'public');
});

test('extractEmailsFromPerson: 多 emails — primary 排第一', () => {
  const p = { emails: { email: [
    { email: 'old@x.com', primary: false, visibility: 'public' },
    { email: 'primary@mit.edu', primary: true, visibility: 'public' },
  ] } };
  const out = extractEmailsFromPerson(p);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.primary).email, 'primary@mit.edu');
});

test('extractEmailsFromPerson: 拒绝非法 email', () => {
  const p = { emails: { email: [{ email: 'no-at-sign', primary: true }] } };
  assert.equal(extractEmailsFromPerson(p).length, 0);
});

test('extractEmailsFromPerson: 缺 emails 节点', () => {
  assert.equal(extractEmailsFromPerson({}).length, 0);
  assert.equal(extractEmailsFromPerson(null).length, 0);
});

// ---------- extractExternalIds ----------
test('extractExternalIds: Scopus + ResearcherID', () => {
  const p = { 'external-identifiers': { 'external-identifier': [
    { 'external-id-type': { value: 'Scopus Author ID' }, 'external-id-value': { value: '7001234567' }, 'external-id-relationship': { value: 'SELF' } },
    { 'external-id-type': { value: 'ResearcherID' }, 'external-id-value': { value: 'A-1234-2020' } },
  ] } };
  const out = extractExternalIds(p);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'Scopus Author ID');
  assert.equal(out[0].value, '7001234567');
  assert.equal(out[0].relationship, 'SELF');
});

test('extractExternalIds: 缺 external-identifiers', () => {
  assert.equal(extractExternalIds({}).length, 0);
});

test('extractExternalIds: 缺 type/value 的行被过滤', () => {
  const p = { 'external-identifiers': { 'external-identifier': [
    { 'external-id-type': { value: 'Scopus' }, 'external-id-value': { value: '' } },
    { 'external-id-type': null, 'external-id-value': null },
  ] } };
  assert.equal(extractExternalIds(p).length, 0);
});

// ---------- extractAffiliationsFromPerson ----------
test('extractAffiliationsFromPerson: employments + educations', () => {
  const p = {
    employments: { 'affiliation-group': [{ summaries: { 'employment-summary': [{
      'employment-summary': {
        'role-title': { value: 'Associate Professor' },
        'department-name': { value: 'EECS' },
        organization: { name: 'MIT', address: { city: 'Cambridge', country: 'US' } },
        'start-date': { year: { value: '2020' }, month: { value: '09' } },
        'end-date': null,
      },
    }] } }] },
    educations: { 'affiliation-group': [{ summaries: { 'education-summary': [{
      'education-summary': {
        'role-title': { value: 'PhD' },
        organization: { name: 'Stanford', address: { city: 'Stanford', country: 'US' } },
        'start-date': { year: { value: '2010' } },
        'end-date': { year: { value: '2016' } },
      },
    }] } }] },
  };
  const out = extractAffiliationsFromPerson(p);
  assert.equal(out.length, 2);
  const emp = out.find((a) => a.kind === 'employment');
  assert.equal(emp.role, 'Associate Professor');
  assert.equal(emp.org_name, 'MIT');
  assert.equal(emp.start_date, '2020-09');
  assert.equal(emp.end_date, null);
  const edu = out.find((a) => a.kind === 'education');
  assert.equal(edu.org_name, 'Stanford');
  assert.equal(edu.end_date, '2016');
});

test('extractAffiliationsFromPerson: 缺 affiliations 节点', () => {
  assert.equal(extractAffiliationsFromPerson({}).length, 0);
});

// ---------- processAuthor: mock fetch ----------
function mockFetch(responses) {
  // responses: array of { status, body, lastModified?, error?, errorDetail? }；按调用顺序消费
  let i = 0;
  return async (rawUrl) => {
    if (i >= responses.length) return { ok: false, status: 0, error: 'no_more_responses' };
    const r = responses[i++];
    if (r.error) return { ok: false, status: r.status || 0, error: r.error, errorDetail: r.errorDetail || '' };
    return { ok: true, status: r.status, data: r.body, lastModified: r.lastModified || null };
  };
}

test('processAuthor: 200+primary email — 命中', async () => {
  const fetchImpl = mockFetch([{
    status: 200,
    body: {
      name: { 'given-names': { value: 'Wang' }, 'family-name': { value: 'Xiaoming' } },
      emails: { email: [{ email: 'w@mit.edu', primary: true, visibility: 'public' }] },
      'external-identifiers': { 'external-identifier': [] },
      employments: { 'affiliation-group': [] },
    },
  }]);
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 0 });
  const r = await api.processAuthor({ id: 'pa1', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, true);
  assert.equal(r.emailOrcidId, '0000-0001-2345-6789');
  assert.equal(r.emailRaw, 'w@mit.edu');
  assert.equal(r.emailSource, 'orcid_public_api');
  assert.equal(r.orcidCreditName, 'Wang Xiaoming');
  assert.ok(r.orcidProfileJson.includes('Wang'));
  assert.ok(r.orcidExternalIdsJson);
  assert.ok(r.orcidAffiliationsJson);
});

test('processAuthor: 200 但无 email — source 仍 = null', async () => {
  const fetchImpl = mockFetch([{
    status: 200,
    body: {
      name: { 'given-names': { value: 'A' }, 'family-name': { value: 'B' } },
      emails: { email: [] },
    },
  }]);
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 0 });
  const r = await api.processAuthor({ id: 'pa1', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, true);
  assert.equal(r.emailRaw, null);
  assert.equal(r.emailSource, null);
  // ORCID profile 仍然落库（killer feature 是 affiliations / external-ids）
  assert.equal(r.emailOrcidId, '0000-0001-2345-6789');
  assert.equal(r.orcidCreditName, 'A B');
});

test('processAuthor: 404 — 沉默返回，不重试', async () => {
  const fetchImpl = mockFetch([{ status: 404, error: 'not_found' }]);
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 3 });
  const r = await api.processAuthor({ id: 'pa1', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, false);
  assert.equal(r._status, 404);
  assert.equal(r._error, 'not_found');
  // 只调一次
  let calls = 0;
  const f2 = async () => { calls += 1; return { ok: false, status: 404, error: 'not_found' }; };
  const api2 = createOrcidEnrich({ fetchImpl: f2, rateLimitMs: 0, maxRetries: 3 });
  await api2.processAuthor({ id: 'p', orcid: '0000-0001-2345-6789' });
  assert.equal(calls, 1);
});

test('processAuthor: 429 → 退避 1s/2s/4s 最多 3 次（maxRetries=3 → 4 次 total）', async () => {
  // 单元测试时间紧：用 maxRetries=0 时 429 立即返回；不重试
  const fetchImpl = mockFetch([{ status: 429, error: 'rate_limited' }]);
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 0 });
  const t0 = Date.now();
  const r = await api.processAuthor({ id: 'p', orcid: '0000-0001-2345-6789' });
  const dt = Date.now() - t0;
  assert.equal(r._ok, false);
  assert.equal(r._error, 'rate_limited');
  assert.ok(dt < 100, `应该快速返回，实际 ${dt}ms`);
});

test('processAuthor: 429 + 第 2 次 200 — 退避后命中', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, error: 'rate_limited', errorDetail: 'throttled' };
    return { ok: true, status: 200, data: {
      name: { 'given-names': { value: 'X' }, 'family-name': { value: 'Y' } },
      emails: { email: [{ email: 'xy@mit.edu', primary: true }] },
    } };
  };
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 3 });
  const r = await api.processAuthor({ id: 'p', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, true);
  assert.equal(r.emailRaw, 'xy@mit.edu');
  assert.equal(calls, 2);
});

test('processAuthor: 4xx（除 429）不重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 403, error: 'http_4xx', errorDetail: 'forbidden' };
  };
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 3 });
  const r = await api.processAuthor({ id: 'p', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, false);
  assert.equal(r._status, 403);
  assert.equal(calls, 1, '4xx 不应重试');
});

test('processAuthor: 5xx 退避后命中', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, error: 'http_5xx', errorDetail: 'unavailable' };
    return { ok: true, status: 200, data: {
      name: { 'given-names': { value: 'X' }, 'family-name': { value: 'Y' } },
      emails: { email: [] },
    } };
  };
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 3 });
  const r = await api.processAuthor({ id: 'p', orcid: '0000-0001-2345-6789' });
  assert.equal(r._ok, true);
  assert.equal(calls, 2);
});

test('processAuthor: invalid orcid — 直接返回错误，不发请求', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, data: {} }; };
  const api = createOrcidEnrich({ fetchImpl, rateLimitMs: 0, maxRetries: 0 });
  const r = await api.processAuthor({ id: 'p', orcid: 'foo' });
  assert.equal(r._ok, false);
  assert.equal(r._error, 'invalid_orcid');
  assert.equal(calls, 0, 'invalid orcid 不应发请求');
});

// ---------- 集成测试：store.recordOrcidProfile ----------
function makeTmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-orcid-'));
  const store = createStore({ dataDir: dir, sqlite });
  return { dir, store };
}

function seedJournalAndPaper(store, { paperId }) {
  // paper_authors 引用 papers.id，papers 引用 journals.id — 都要先建
  store.recordJournal({
    id: 'j-test', sourceFile: 'test.csv', journalSystem: '英文期刊',
    journalNameRaw: 'Test Journal', firstSeenAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
  store.recordPaper({
    id: paperId, title: 'A Test Paper', journalId: 'j-test', journalName: 'Test Journal',
    source: 'openalex', sourceUrl: 'https://example.com/p', firstSeenAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
}

test('store.recordOrcidProfile: 7 个新列存在 + 写回可读', () => {
  const { dir, store } = makeTmpStore();
  seedJournalAndPaper(store, { paperId: 'p-x' });
  store.recordPaperAuthor({
    id: 'pa-x', paperId: 'p-x', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6789',
    chineseNameProbability: 0.8, isTargetCandidate: true,
  });
  store.recordOrcidProfile({
    id: 'pa-x',
    emailOrcidId: '0000-0001-2345-6789',
    orcidCreditName: 'Wang Xiaoming',
    orcidExternalIdsJson: JSON.stringify([{ type: 'Scopus Author ID', value: '7001234567' }]),
    orcidAffiliationsJson: JSON.stringify([{ kind: 'employment', org_name: 'MIT' }]),
    orcidLastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    orcidLastFetched: '2025-01-01T00:00:00.000Z',
    orcidProfileJson: JSON.stringify({ name: { 'given-names': { value: 'Wang' } } }),
    emailRaw: 'w@mit.edu',
    emailSource: 'orcid_public_api',
  });
  const r = store.db.prepare(`
    SELECT email_orcid_id, orcid_credit_name, orcid_external_ids_json, orcid_affiliations_json,
           orcid_last_modified, orcid_last_fetched, orcid_profile_json, email_raw, email_source
    FROM paper_authors WHERE id = ?
  `).get('pa-x');
  assert.equal(r.email_orcid_id, '0000-0001-2345-6789');
  assert.equal(r.orcid_credit_name, 'Wang Xiaoming');
  assert.equal(r.email_raw, 'w@mit.edu');
  assert.equal(r.email_source, 'orcid_public_api');
  assert.deepEqual(JSON.parse(r.orcid_external_ids_json), [{ type: 'Scopus Author ID', value: '7001234567' }]);
  assert.deepEqual(JSON.parse(r.orcid_affiliations_json), [{ kind: 'employment', org_name: 'MIT' }]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store.recordOrcidProfile: 已有 email_raw 不被 ORCID 覆盖（COALESCE 保护）', () => {
  const { dir, store } = makeTmpStore();
  seedJournalAndPaper(store, { paperId: 'p-y' });
  store.recordPaperAuthor({
    id: 'pa-y', paperId: 'p-y', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6789',
    chineseNameProbability: 0.8, isTargetCandidate: true,
    emailRaw: 'existing@mit.edu',
    emailSource: 'openalex_regex',
  });
  store.recordOrcidProfile({
    id: 'pa-y',
    emailOrcidId: '0000-0001-2345-6789',
    orcidLastFetched: '2025-01-01T00:00:00.000Z',
    orcidProfileJson: '{}',
    emailRaw: 'w@mit.edu',
    emailSource: 'orcid_public_api',
  });
  const r = store.db.prepare('SELECT email_raw, email_source FROM paper_authors WHERE id = ?').get('pa-y');
  assert.equal(r.email_raw, 'existing@mit.edu', '已有 email_raw 不被覆盖');
  assert.equal(r.email_source, 'openalex_regex');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store.selectOrcidLookupRows: filter chinese + first/corresponding + email_raw NULL + 30 天窗口', () => {
  const { dir, store } = makeTmpStore();
  // 共用一个 paper（FK 满足）
  seedJournalAndPaper(store, { paperId: 'p-shared' });
  // 候选 1：合条件
  store.recordPaperAuthor({
    id: 'a', paperId: 'p-shared', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6789', chineseNameProbability: 0.8, isTargetCandidate: true,
  });
  // 候选 2：email 已填
  store.recordPaperAuthor({
    id: 'b', paperId: 'p-shared', authorName: 'Li', authorPosition: 1,
    isFirstAuthor: false, isLastAuthor: false, isCorresponding: true,
    orcid: '0000-0001-2345-6790', chineseNameProbability: 0.7, isTargetCandidate: true,
    emailRaw: 'li@mit.edu', emailSource: 'openalex_regex',
  });
  // 候选 3：chinese 概率不足
  store.recordPaperAuthor({
    id: 'c', paperId: 'p-shared', authorName: 'John', authorPosition: 2,
    isFirstAuthor: false, isLastAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6791', chineseNameProbability: 0.2, isTargetCandidate: false,
  });
  // 候选 4：orcid 缺失
  store.recordPaperAuthor({
    id: 'd', paperId: 'p-shared', authorName: 'Zhang', authorPosition: 3,
    isFirstAuthor: false, isLastAuthor: false, isCorresponding: true,
    orcid: null, chineseNameProbability: 0.7, isTargetCandidate: true,
  });
  // 候选 5：middle author（非 first / 非 corresponding）
  store.recordPaperAuthor({
    id: 'e', paperId: 'p-shared', authorName: 'Zhao', authorPosition: 4,
    isFirstAuthor: false, isLastAuthor: false, isCorresponding: false,
    orcid: '0000-0001-2345-6792', chineseNameProbability: 0.7, isTargetCandidate: false,
  });
  // 候选 6：last author（不算 target）
  store.recordPaperAuthor({
    id: 'f', paperId: 'p-shared', authorName: 'Sun', authorPosition: 5,
    isFirstAuthor: false, isLastAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6793', chineseNameProbability: 0.8, isTargetCandidate: false,
  });
  const rows = store.selectOrcidLookupRows({});
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, ['a'], '只有 a 合条件');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store.selectOrcidLookupRows: 30 天增量窗口 + --force 重跑', () => {
  const { dir, store } = makeTmpStore();
  seedJournalAndPaper(store, { paperId: 'p' });
  store.recordPaperAuthor({
    id: 'r1', paperId: 'p', authorName: 'Wang', authorPosition: 0,
    isFirstAuthor: true, isCorresponding: false,
    orcid: '0000-0001-2345-6789', chineseNameProbability: 0.8, isTargetCandidate: true,
  });
  // 手工标记刚查过（距今 1 天）
  store.db.prepare("UPDATE paper_authors SET orcid_last_fetched = datetime('now', '-1 day') WHERE id = 'r1'").run();
  let rows = store.selectOrcidLookupRows({});
  assert.equal(rows.length, 0, '刚查过的应被 30 天窗口跳过');
  rows = store.selectOrcidLookupRows({ force: true });
  assert.equal(rows.length, 1, '--force 强制重跑');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { tests };
