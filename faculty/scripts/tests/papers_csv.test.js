// tests/papers_csv.test.js — 单元测试：期刊清单 CSV 解析

'use strict';

const assert = require('node:assert/strict');
const {
  parseJournalsCsv,
  splitCsvLine,
  canonicalIssn,
  canonicalCn,
  looksLikeIssn,
  looksLikeCn,
  journalId,
} = require('../lib/papers_csv.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('splitCsvLine: 普通行', () => {
  const cols = splitCsvLine('a,b,c');
  assert.deepEqual(cols, ['a', 'b', 'c']);
});

test('splitCsvLine: 含逗号在引号内', () => {
  const cols = splitCsvLine('"a,b",c,"d,e,f"');
  assert.deepEqual(cols, ['a,b', 'c', 'd,e,f']);
});

test('splitCsvLine: "" 转义', () => {
  const cols = splitCsvLine('"a""b",c');
  assert.deepEqual(cols, ['a"b', 'c']);
});

test('canonicalIssn: 标准 ISSN 8 位', () => {
  assert.equal(canonicalIssn('0025-1909'), '00251909');
  assert.equal(canonicalIssn('0025 1909'), '00251909');
  assert.equal(canonicalIssn(' 0025-1909 '), '00251909');
});

test('canonicalIssn: 非法格式返回 null', () => {
  assert.equal(canonicalIssn('11-1235/F'), null);
  assert.equal(canonicalIssn(''), null);
  assert.equal(canonicalIssn(null), null);
});

test('canonicalCn: 标准 CN', () => {
  assert.equal(canonicalCn('11-1235/F'), '11-1235/F');
  assert.equal(canonicalCn(' 11-1235/F '), '11-1235/F');
  assert.equal(canonicalCn('11-1235/F2'), '11-1235/F2');
});

test('canonicalCn: 非法返回 null', () => {
  assert.equal(canonicalCn('0025-1909'), null);
  assert.equal(canonicalCn(''), null);
});

test('looksLikeIssn / looksLikeCn 互斥', () => {
  assert.ok(looksLikeIssn('0025-1909'));
  assert.ok(!looksLikeIssn('11-1235/F'));
  assert.ok(looksLikeCn('11-1235/F'));
  assert.ok(!looksLikeCn('0025-1909'));
});

test('journalId: 同输入同 id', () => {
  const a = journalId({ sourceFile: 'f', name: 'X', issn: '00251909', cn: null });
  const b = journalId({ sourceFile: 'f', name: 'X', issn: '00251909', cn: null });
  assert.equal(a, b);
  assert.equal(a.length, 40);
});

test('journalId: 不同 name 不同 id', () => {
  const a = journalId({ sourceFile: 'f', name: 'X', issn: '00251909', cn: null });
  const b = journalId({ sourceFile: 'f', name: 'Y', issn: '00251909', cn: null });
  assert.notEqual(a, b);
});

test('parseJournalsCsv: BOM + 真实附件片段', () => {
  const text = '\uFEFF来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\n'
    + '西南财经大学,英文期刊,BUSINESS,MANAGEMENT SCIENCE,0025-1909,A+,强入库论文锚点,管理科学顶刊\n'
    + '西南财经大学,英文期刊,BUSINESS,JOURNAL OF MARKETING,0022-2429,A+,强入库论文锚点,营销\n'
    + '西南财经大学,中文期刊,管理学,管理世界,11-1235/F,A+(TOP),强入库论文锚点,中文管理学TOP\n';
  const { rows, errors } = parseJournalsCsv(text);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);
  // 第一行
  assert.equal(rows[0].journalNameRaw, 'MANAGEMENT SCIENCE');
  assert.equal(rows[0].journalSystem, '英文期刊');
  assert.equal(rows[0].discipline, 'BUSINESS');
  assert.equal(rows[0].issnPrint, '00251909');
  assert.equal(rows[0].cnCode, null);
  assert.equal(rows[0].schoolLevel, 'A+');
  assert.equal(rows[0].usage, '强入库论文锚点');
  assert.equal(rows[0].notes, '管理科学顶刊');
  // 第二行
  assert.equal(rows[1].issnPrint, '00222429');
  // 第三行
  assert.equal(rows[2].journalNameRaw, '管理世界');
  assert.equal(rows[2].issnPrint, null);
  assert.equal(rows[2].cnCode, '11-1235/F');
});

test('parseJournalsCsv: 含逗号在引号内', () => {
  const text = '来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\n'
    + 'src,英文期刊,COMPUTER SCIENCE,"JOURNAL OF MACHINE LEARNING RESEARCH",1532-4435,A+,强入库,机器学习\n';
  const { rows, errors } = parseJournalsCsv(text);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].journalNameRaw, 'JOURNAL OF MACHINE LEARNING RESEARCH');
  assert.equal(rows[0].issnPrint, '15324435');
});

test('parseJournalsCsv: 空姓名 → 报错但不抛异常', () => {
  const text = '来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\n'
    + 'src,英文期刊,X,,0025-1909,A+,x,y\n';
  const { rows, errors } = parseJournalsCsv(text);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /empty journal name/);
});

test('parseJournalsCsv: 缺字段行被跳过', () => {
  const text = '来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\n'
    + 'src,英文期刊,X\n';
  const { rows, errors } = parseJournalsCsv(text);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

test('parseJournalsCsv: id 在重跑时稳定', () => {
  const text1 = '来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\nsrc,英文期刊,X,MANAGEMENT SCIENCE,0025-1909,A+,x,y\n';
  const text2 = '来源文件,期刊体系,学科/方向,期刊名称,ISSN/CN,学校级别,人才库用途,备注\nsrc,英文期刊,X,MANAGEMENT SCIENCE,0025-1909,A+,x,y\n';
  const a = parseJournalsCsv(text1);
  const b = parseJournalsCsv(text2);
  assert.equal(a.rows[0].id, b.rows[0].id);
});

module.exports = { tests };
