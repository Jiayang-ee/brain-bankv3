// tests/paper_extract.test.js — 单元测试：论文与作者抽取

'use strict';

const assert = require('node:assert/strict');
const {
  buildPaperId,
  buildAuthorId,
  extractAuthorships,
  extractPaperRecord,
  normalizeTitle,
  isTargetAuthor,
} = require('../lib/paper_extract.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('buildPaperId: 有 doi → doi:<lower>', () => {
  const id = buildPaperId({ doi: '10.1234/ABC.XYZ', title: 't', year: 2023, source: 'openalex', journalId: 'j' });
  assert.equal(id, 'doi:10.1234/abc.xyz');
});

test('buildPaperId: 无 doi → sha1:<32hex>', () => {
  const id = buildPaperId({ doi: null, title: 'A Sample Paper', year: 2023, source: 'openalex', journalId: 'j' });
  assert.match(id, /^sha1:[a-f0-9]{32}$/);
});

test('buildPaperId: 无 doi 哈希稳定', () => {
  const a = buildPaperId({ doi: null, title: 'Same Title', year: 2024, source: 'openalex', journalId: 'j1' });
  const b = buildPaperId({ doi: null, title: 'Same Title', year: 2024, source: 'openalex', journalId: 'j1' });
  assert.equal(a, b);
});

test('buildPaperId: 标题大小写差异 → 同 id（normalizeTitle）', () => {
  const a = buildPaperId({ doi: null, title: 'A Sample Paper', year: 2024, source: 'openalex', journalId: 'j' });
  const b = buildPaperId({ doi: null, title: 'a sample paper', year: 2024, source: 'openalex', journalId: 'j' });
  assert.equal(a, b);
});

test('buildAuthorId: 稳定 + 唯一', () => {
  const a = buildAuthorId({ paperId: 'p1', position: 0, name: 'Wang Xiaoming' });
  const b = buildAuthorId({ paperId: 'p1', position: 0, name: 'Wang Xiaoming' });
  const c = buildAuthorId({ paperId: 'p1', position: 1, name: 'Wang Xiaoming' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 40);
});

test('extractAuthorships: OpenAlex format → normalized + chinese scoring', () => {
  const work = {
    authorships: [
      { author: { display_name: 'Wang Xiaoming' }, position: 'first', is_corresponding: false,
        raw_affiliation_string: 'Tsinghua University', institutions: [{ id: 'I1', display_name: 'Tsinghua University' }] },
      { author: { display_name: '李伟' }, position: 'last', is_corresponding: true,
        raw_affiliation_string: 'PKU', institutions: [{ id: 'I2', display_name: 'Peking University' }] },
      { author: { display_name: 'John Smith' }, position: 'middle', is_corresponding: false,
        raw_affiliation_string: 'MIT' },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p1', threshold: 0.4 });
  assert.equal(out.length, 3);
  // 0: Wang Xiaoming, first, chinese likely
  assert.equal(out[0].authorName, 'Wang Xiaoming');
  assert.equal(out[0].isFirstAuthor, true);
  assert.equal(out[0].isLastAuthor, false);
  assert.equal(out[0].isCorresponding, false);
  assert.ok(out[0].chineseNameProbability >= 0.4, `got ${out[0].chineseNameProbability}`);
  assert.equal(out[0].isTargetCandidate, true);
  assert.equal(out[0].affiliationName, 'Tsinghua University');
  // 1: 李伟, last, corresponding
  assert.equal(out[1].authorName, '李伟');
  assert.equal(out[1].isLastAuthor, true);
  assert.equal(out[1].isCorresponding, true);
  assert.ok(out[1].chineseNameProbability >= 0.4);
  assert.equal(out[1].isTargetCandidate, true);
  // 2: John Smith — non-chinese
  assert.equal(out[2].authorName, 'John Smith');
  assert.ok(out[2].chineseNameProbability < 0.4);
  assert.equal(out[2].isTargetCandidate, false);
});

test('extractAuthorships: Crossref format → position 0/1/2 + last=corresponding', () => {
  const work = {
    authorships: [
      { name: 'Zhang Ling', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false,
        affiliation_name: 'Fudan' },
      { name: '陈晓', position: 1, is_first_author: false, is_last_author: true, is_corresponding: true,
        affiliation_name: 'SJTU' },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p1', threshold: 0.4 });
  assert.equal(out.length, 2);
  assert.equal(out[0].authorName, 'Zhang Ling');
  assert.equal(out[0].isFirstAuthor, true);
  assert.equal(out[0].isTargetCandidate, true);
  assert.equal(out[1].authorName, '陈晓');
  assert.equal(out[1].isLastAuthor, true);
  assert.equal(out[1].isCorresponding, true);
  assert.ok(out[1].chineseNameProbability >= 0.4);
  assert.equal(out[1].isTargetCandidate, true);
});

test('extractPaperRecord: OpenAlex work → 字段齐全', () => {
  const work = {
    id: 'https://openalex.org/W123',
    doi: 'https://doi.org/10.1234/abc',
    title: 'A great paper',
    publish_year: 2023,
    publish_date: '2023-05-10',
    language: 'en',
    type: 'article',
    cited_by_count: 42,
    issn_l: '00251909',
    source_name: 'MANAGEMENT SCIENCE',
    volume: '69', issue: '5', page_first: '100', page_last: '120',
  };
  const rec = extractPaperRecord({ work, journalId: 'j1', journalName: 'MS', source: 'openalex', issn: '00251909' });
  assert.equal(rec.doi, '10.1234/abc');
  assert.equal(rec.publishYear, 2023);
  assert.equal(rec.publishDate, '2023-05-10');
  assert.equal(rec.citedByCount, 42);
  assert.equal(rec.volume, '69');
  assert.equal(rec.issue, '5');
  assert.equal(rec.page, '100-120');
  assert.equal(rec.source, 'openalex');
  assert.equal(rec.openalexId, 'https://openalex.org/W123');
  assert.equal(rec.id, 'doi:10.1234/abc');
});

test('extractPaperRecord: 无 doi → sha1 id', () => {
  const work = {
    id: 'https://openalex.org/W999',
    title: 'A title',
    publish_year: 2024,
    publish_date: '2024-01-01',
  };
  const rec = extractPaperRecord({ work, journalId: 'j1', journalName: 'J', source: 'openalex', issn: null });
  assert.match(rec.id, /^sha1:[a-f0-9]{32}$/);
});

test('isTargetAuthor: 任一条件满足即 true', () => {
  assert.equal(isTargetAuthor({ is_first_author: true, is_last_author: false, is_corresponding: false }), true);
  assert.equal(isTargetAuthor({ is_first_author: false, is_last_author: true, is_corresponding: false }), true);
  assert.equal(isTargetAuthor({ is_first_author: false, is_last_author: false, is_corresponding: true }), true);
  assert.equal(isTargetAuthor({ is_first_author: false, is_last_author: false, is_corresponding: false }), false);
});

test('normalizeTitle: 大小写 / 标点统一', () => {
  assert.equal(normalizeTitle('A Sample Paper'), normalizeTitle('a sample paper'));
  assert.equal(normalizeTitle('  A   Sample   Paper  '), normalizeTitle('a sample paper'));
  // 不同 unicode 横线统一
  assert.equal(normalizeTitle('paper-title'), normalizeTitle('paper\u2013title'));
});

test('extractAuthorships: 跳过匿名作者', () => {
  const work = { authorships: [{ name: null }, {}, null] };
  const out = extractAuthorships({ work, paperId: 'p1' });
  assert.equal(out.length, 0);
});

test('extractAuthorships: 通讯作者非首/末位也记为 target', () => {
  const work = {
    authorships: [
      { name: 'John Smith', position: 0, is_first_author: true, is_corresponding: false },
      { name: 'Li Hua', position: 1, is_first_author: false, is_last_author: false, is_corresponding: true },
      { name: 'Bob Jones', position: 2, is_first_author: false, is_last_author: true, is_corresponding: false },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p', threshold: 0.4 });
  // Li Hua is corresponding + chinese → target
  const li = out.find((a) => a.authorName === 'Li Hua');
  assert.ok(li);
  assert.equal(li.isCorresponding, true);
  assert.equal(li.isTargetCandidate, true);
});

test('extractAuthorships: 邮箱抽到 → emailRaw / emailSource / emailMatchContext 写入', () => {
  const work = {
    authorships: [
      { name: 'Wang Xiaoming', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false,
        affiliation_raw: 'Tsinghua University; Corresponding author: wang@tsinghua.edu.cn' },
      { name: 'John Smith', position: 1, is_first_author: false, is_last_author: true, is_corresponding: true,
        affiliation_raw: 'MIT CSAIL' },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p', threshold: 0.4 });
  // Wang: 邮箱命中 (Corresponding author 段)
  assert.equal(out[0].emailRaw, 'wang@tsinghua.edu.cn');
  assert.equal(out[0].emailSource, 'openalex_regex');
  assert.ok(out[0].emailMatchContext && out[0].emailMatchContext.includes('wang@tsinghua.edu.cn'));
  // John: 无邮箱 → null 三件套
  assert.equal(out[1].emailRaw, null);
  assert.equal(out[1].emailSource, null);
  assert.equal(out[1].emailMatchContext, null);
});

test('extractAuthorships: OpenAlex raw_affiliation_strings (数组) → join + email 抽取', () => {
  // 模拟 OpenAlex 实际响应：raw_affiliation_strings 是 string[]
  const work = {
    authorships: [
      { name: 'Wang Xiaoming', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false,
        raw_affiliation_strings: [
          'Department of Industrial Engineering, Tsinghua University, Beijing, China',
          'Corresponding author: wang.xm@tsinghua.edu.cn',
        ],
        institutions: [{ id: 'I1', display_name: 'Tsinghua University' }] },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p1', threshold: 0.4 });
  // affiliation_raw 应为 join 后的字符串
  assert.equal(out[0].affiliationRaw, 'Department of Industrial Engineering, Tsinghua University, Beijing, China; Corresponding author: wang.xm@tsinghua.edu.cn');
  // 邮箱命中 (Corresponding author 段，confidence=0.9)
  assert.equal(out[0].emailRaw, 'wang.xm@tsinghua.edu.cn');
  assert.equal(out[0].emailSource, 'openalex_regex');
  assert.ok(out[0].emailMatchContext && out[0].emailMatchContext.includes('wang.xm@tsinghua.edu.cn'));
});

test('extractAuthorships: 无 raw_affiliation_strings → affiliation_raw = null + email = null', () => {
  const work = {
    authorships: [
      { name: 'John Smith', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false,
        institutions: [{ id: 'I1', display_name: 'MIT' }] },
    ],
  };
  const out = extractAuthorships({ work, paperId: 'p1', threshold: 0.4 });
  assert.equal(out[0].affiliationRaw, null);
  assert.equal(out[0].emailRaw, null);
  assert.equal(out[0].emailSource, null);
});

test('extractAuthorships: 同位置同人重抓 → email 字段更新（upsert）', () => {
  const work = {
    authorships: [
      { name: 'Wang Xiaoming', position: 0, is_first_author: true, is_last_author: false, is_corresponding: false,
        affiliation_raw: 'Tsinghua University; wang@tsinghua.edu.cn' },
    ],
  };
  const out1 = extractAuthorships({ work, paperId: 'p', threshold: 0.4 });
  // 第一次：无 Corresponding author 标记 → low confidence
  assert.equal(out1[0].emailRaw, 'wang@tsinghua.edu.cn');
  assert.equal(out1[0].emailSource, 'openalex_regex');
  // 改 affiliation 后：再抽
  work.authorships[0].affiliation_raw = 'Tsinghua University; Corresponding author: wang@tsinghua.edu.cn';
  const out2 = extractAuthorships({ work, paperId: 'p', threshold: 0.4 });
  // id 稳定（同名同位置），email 字段更新
  assert.equal(out2[0].id, out1[0].id);
  assert.equal(out2[0].emailRaw, 'wang@tsinghua.edu.cn');
  assert.ok(out2[0].emailMatchContext.includes('Corresponding author'));
});

module.exports = { tests };
