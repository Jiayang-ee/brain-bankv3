// tests/papers_flow.test.js — 单元测试：OpenAlex / Crossref 客户端 + 端到端 mini pipeline（dry-run）

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createOpenAlex } = require('../lib/openalex.js');
const { createCrossref } = require('../lib/crossref.js');
const { parseJournalsCsv } = require('../lib/papers_csv.js');
const { extractAuthorships, extractPaperRecord } = require('../lib/paper_extract.js');
const { createStore } = require('../lib/storage.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 简易 fake fetch：路由表 /responses/<key>.json → 内容；未注册 → 404
function makeFakeFetch(responses) {
  return (rawUrl) => {
    for (const [key, body] of Object.entries(responses)) {
      if (rawUrl.includes(key)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: body,
        });
      }
    }
    return Promise.resolve({ ok: false, error: 'http_error', status: 404, errorDetail: 'not found' });
  };
}

test('createOpenAlex.findSourceByIssn: 命中后返回 source 对象', async () => {
  const fake = makeFakeFetch({
    '/sources?filter=issn%3A0025-1909': {
      results: [{
        id: 'S4210190000',
        issn_l: '0025-1909',
        issn: ['0025-1909', '1526-5501'],
        display_name: 'Management Science',
        type: 'journal',
        works_count: 12345,
        cited_by_count: 9999,
      }],
    },
  });
  const oa = createOpenAlex({ fetchImpl: fake, rateLimitMs: 0 });
  const src = await oa.findSourceByIssn('0025-1909');
  assert.ok(src);
  assert.equal(src.id, 'S4210190000');
  assert.equal(src.issn_l, '0025-1909');
  assert.equal(src.display_name, 'Management Science');
});

test('createOpenAlex.findSourceByIssn: 0 results → null', async () => {
  const fake = makeFakeFetch({
    '/sources?filter=issn%3A9999-9999': { results: [] },
    '/sources?filter=issn_l%3A9999-9999': { results: [] },
  });
  const oa = createOpenAlex({ fetchImpl: fake, rateLimitMs: 0 });
  const src = await oa.findSourceByIssn('9999-9999');
  assert.equal(src, null);
});

test('createOpenAlex.findSourceByIssn: API 错误 → _error 包裹', async () => {
  const fake = () => Promise.resolve({ ok: false, error: 'http_error', status: 500, errorDetail: 'oops' });
  const oa = createOpenAlex({ fetchImpl: fake, rateLimitMs: 0 });
  const src = await oa.findSourceByIssn('0025-1909');
  assert.ok(src);
  assert.equal(src._error.error, 'http_error');
});

test('createOpenAlex.iterateWorks: 单页 → callback 一次后停止', async () => {
  let calls = 0;
  const fake = (rawUrl) => {
    calls += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        results: [
          { id: 'W1', doi: '10.1/a', title: 'P1', publication_year: 2023, publication_date: '2023-01-01',
            type: 'article', cited_by_count: 1, primary_location: { source: { id: 'S1', issn_l: '0025-1909' } },
            authorships: [{ author: { display_name: 'Wang' }, position: 'first' }] },
        ],
        meta: { next_cursor: null },
      },
    });
  };
  const oa = createOpenAlex({ fetchImpl: fake, rateLimitMs: 0 });
  let seen = 0;
  const r = await oa.iterateWorks({
    sourceId: 'S1',
    from: '2021-01-01', until: '2026-06-03',
    onPage: ({ results }) => { seen += results.length; },
    maxPages: 5,
  });
  assert.equal(r.ok, true);
  assert.equal(seen, 1);
  assert.equal(r.pages, 1);
  assert.equal(calls, 1);
});

test('createOpenAlex.iterateWorks: 多页 → 跟随 cursor 直到 null', async () => {
  let calls = 0;
  const fake = (rawUrl) => {
    calls += 1;
    const isFirst = !rawUrl.includes('cursor=ABC');
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        results: [{ id: `W${calls}`, title: 'P', publication_year: 2024, publication_date: '2024-01-01',
          authorships: [] }],
        meta: isFirst ? { next_cursor: 'ABC' } : { next_cursor: null },
      },
    });
  };
  const oa = createOpenAlex({ fetchImpl: fake, rateLimitMs: 0 });
  const r = await oa.iterateWorks({ sourceId: 'S1', from: '2021-01-01', until: '2026-06-03', onPage: () => {}, maxPages: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.pages, 2);
  assert.equal(calls, 2);
});

test('createCrossref.findJournal: 命中', async () => {
  const fake = makeFakeFetch({
    '/journals/00251909': {
      message: {
        title: 'Management Science',
        publisher: 'INFORMS',
        ISSN: ['0025-1909', '1526-5501'],
        subject: ['Management'],
      },
    },
  });
  const cr = createCrossref({ fetchImpl: fake, rateLimitMs: 0 });
  const j = await cr.findJournal('0025-1909');
  assert.ok(j);
  assert.equal(j.title, 'Management Science');
});

test('createCrossref.findJournal: 404 → _error', async () => {
  const fake = () => Promise.resolve({ ok: false, error: 'http_error', status: 404, errorDetail: 'not found' });
  const cr = createCrossref({ fetchImpl: fake, rateLimitMs: 0 });
  const j = await cr.findJournal('0025-1909');
  assert.ok(j);
  assert.equal(j._error.status, 404);
});

test('createCrossref.iterateWorks: offset 翻页', async () => {
  const fake = (rawUrl) => {
    if (rawUrl.includes('offset=0')) {
      return Promise.resolve({
        ok: true, status: 200,
        data: {
          message: {
            items: [
              { DOI: '10.1/a', title: ['P1'], published: { 'date-parts': [[2023, 1, 1]] },
                author: [{ given: 'Wang', family: 'Xiaoming', sequence: 'first' }] },
            ],
            'total-results': 2,
          },
        },
      });
    }
    if (rawUrl.includes('offset=1')) {
      return Promise.resolve({
        ok: true, status: 200,
        data: {
          message: {
            items: [
              { DOI: '10.1/b', title: ['P2'], published: { 'date-parts': [[2024, 5, 1]] },
                author: [{ given: 'Li', family: 'Wei', sequence: 'first' }] },
            ],
            'total-results': 2,
          },
        },
      });
    }
    return Promise.resolve({ ok: false, error: 'http_error', status: 404 });
  };
  const cr = createCrossref({ fetchImpl: fake, rateLimitMs: 0 });
  const r = await cr.iterateWorks({ issn: '0025-1909', from: '2021-01-01', until: '2026-06-03', onPage: () => {}, rows: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.pages, 2);
});

test('createCrossref.normalizeWork: author 合并 + last = corresponding', () => {
  const cr = createCrossref({});
  const item = {
    DOI: '10.1/x',
    title: ['A Paper'],
    published: { 'date-parts': [[2023, 6, 1]] },
    author: [
      { given: 'Wang', family: 'Xiaoming', sequence: 'first' },
      { given: 'Li', family: 'Wei', sequence: 'additional' },
    ],
    'container-title': ['Management Science'],
    volume: '69', issue: '6',
  };
  const w = cr.normalizeWork(item);
  assert.equal(w.title, 'A Paper');
  assert.equal(w.publish_year, 2023);
  assert.equal(w.publish_date, '2023-06-01');
  assert.equal(w.authorships.length, 2);
  assert.equal(w.authorships[0].name, 'Wang Xiaoming');
  assert.equal(w.authorships[0].is_first_author, true);
  assert.equal(w.authorships[0].is_corresponding, false);
  assert.equal(w.authorships[1].name, 'Li Wei');
  assert.equal(w.authorships[1].is_last_author, true);
  assert.equal(w.authorships[1].is_corresponding, true); // 末位 = 通讯（启发式）
  assert.equal(w.source_name, 'Management Science');
});

test('createOpenAlex.normalizeWork: 抽取 authorships + biblio', () => {
  const oa = createOpenAlex({});
  const w = oa.normalizeWork({
    id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1/abc',
    title: 'Open Alex Paper',
    publication_year: 2023,
    publication_date: '2023-04-01',
    language: 'en',
    type: 'article',
    cited_by_count: 5,
    primary_location: { source: { id: 'S1', issn_l: '0025-1909', display_name: 'MS' } },
    biblio: { volume: '69', issue: '4', first_page: '100', last_page: '120' },
    authorships: [
      { author: { display_name: 'Wang Xiaoming' }, position: 'first', is_corresponding: false,
        institutions: [{ id: 'I1', display_name: 'Tsinghua' }] },
    ],
  });
  assert.equal(w.doi, '10.1/abc');
  assert.equal(w.publish_year, 2023);
  assert.equal(w.volume, '69');
  assert.equal(w.issue, '4');
  assert.equal(w.page_first, '100');
  assert.equal(w.page_last, '120');
  assert.equal(w.authorships.length, 1);
  // OpenAlex 原始结构保留 author.display_name；通过 extractAuthorships 才会被规范化为 name
  assert.equal(w.authorships[0].author.display_name, 'Wang Xiaoming');
});

test('dry-run end-to-end: 1 期刊 → 1 论文 + 多个作者 + target candidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bra9-e2e-'));
  const store = createStore({ dataDir: dir, sqlite });
  // 直接构造 paper 记录并写入
  const journal = {
    id: 'j1',
    sourceFile: 'test',
    journalNameRaw: 'MANAGEMENT SCIENCE',
    journalSystem: '英文期刊',
    schoolLevel: 'A+',
    issnPrint: '00251909',
    cnCode: null,
  };
  store.recordJournal({ ...journal, queryStatus: 'pending' });
  const work = {
    id: 'https://openalex.org/W1',
    doi: '10.1234/test',
    title: 'Test paper',
    publish_year: 2023, publish_date: '2023-01-01',
    type: 'article', cited_by_count: 0, issn_l: '00251909',
    source_name: 'MANAGEMENT SCIENCE',
    authorships: [
      { name: 'Wang Xiaoming', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false, affiliation_name: 'Tsinghua' },
      { name: '陈晓', position: 1, is_first_author: false, is_last_author: true, is_corresponding: true, affiliation_name: 'SJTU' },
      { name: 'John Smith', position: 2, is_first_author: false, is_last_author: false, is_corresponding: false, affiliation_name: 'MIT' },
    ],
  };
  const paperRec = extractPaperRecord({ work, journalId: 'j1', journalName: 'MS', source: 'openalex', issn: '00251909' });
  store.recordPaper(paperRec);
  const auths = extractAuthorships({ work, paperId: paperRec.id, threshold: 0.4 });
  for (const a of auths) store.recordPaperAuthor(a);

  // 验证
  const pCount = store.db.prepare('SELECT COUNT(*) AS n FROM papers').get().n;
  assert.equal(pCount, 1);
  const aCount = store.db.prepare('SELECT COUNT(*) AS n FROM paper_authors').get().n;
  assert.equal(aCount, 3);
  const target = store.db.prepare('SELECT * FROM paper_authors WHERE is_target_candidate = 1 ORDER BY author_position').all();
  assert.equal(target.length, 2);
  // Wang (first) + 陈晓 (last + corresponding)
  const names = target.map((t) => t.author_name).sort();
  assert.deepEqual(names, ['Wang Xiaoming', '陈晓'].sort());
  // chinese_likely = 2
  const chs = store.db.prepare('SELECT COUNT(*) AS n FROM paper_authors WHERE chinese_name_probability >= 0.4').get().n;
  assert.equal(chs, 2);
  // 重跑幂等：再写一次同名 author
  store.recordPaperAuthor(auths[0]);
  const aCount2 = store.db.prepare('SELECT COUNT(*) AS n FROM paper_authors').get().n;
  assert.equal(aCount2, 3);

  // 写 journal 终态
  store.recordJournal({
    ...journal,
    openalexSourceId: 'S1',
    queryStatus: 'success',
    papersFound: 1, papersKept: 1,
    authorsFound: 3, authorsChs: 2, authorsTarget: 2,
    lastQueryAt: new Date().toISOString(),
  });
  const stats = store.getJournalStats();
  assert.deepEqual(stats.journal_status, { success: 1 });
  assert.equal(stats.papers.total_papers, 1);
  assert.equal(stats.authors.target_candidates, 2);
  assert.equal(stats.authors.chinese_likely, 2);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseJournalsCsv → 真实 51 行 + 1 表头', () => {
  const csv = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'data', 'journals.csv'), 'utf8',
  );
  const { rows, errors } = parseJournalsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 51);
  // 12 中文 + 39 英文
  const cn = rows.filter((r) => r.journalSystem === '中文期刊').length;
  const en = rows.filter((r) => r.journalSystem === '英文期刊').length;
  assert.equal(cn + en, 51);
  assert.equal(cn, 12);
  assert.equal(en, 39);
  // 至少一本有 print-ISSN
  const withIssn = rows.filter((r) => r.issnPrint).length;
  assert.ok(withIssn >= 30, `expected >=30 ISSNs, got ${withIssn}`);
  // 至少一本有 CN
  const withCn = rows.filter((r) => r.cnCode).length;
  assert.ok(withCn >= 10, `expected >=10 CNs, got ${withCn}`);
  // MANAGEMENT SCIENCE 是英文期刊 + 有 ISSN
  const ms = rows.find((r) => r.journalNameRaw === 'MANAGEMENT SCIENCE');
  assert.ok(ms);
  assert.equal(ms.issnPrint, '00251909');
  assert.equal(ms.cnCode, null);
  assert.equal(ms.schoolLevel, 'A+');
  // 管理世界 是中文期刊 + 有 CN 无 ISSN
  const gw = rows.find((r) => r.journalNameRaw === '管理世界');
  assert.ok(gw);
  assert.equal(gw.issnPrint, null);
  assert.equal(gw.cnCode, '11-1235/F');
});

module.exports = { tests };
