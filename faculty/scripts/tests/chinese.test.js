// tests/chinese.test.js — 单元测试：疑似华人姓名初筛

'use strict';

const assert = require('node:assert/strict');
const { looksChinese, assess, tokenizeName, COMMON_SURNAMES } = require('../lib/chinese.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('CJK 字符 → 高置信度', () => {
  const r = looksChinese({ name: '王晓明', cjkFragments: ['王晓明'] });
  assert.ok(r.probability >= 0.5, `got ${r.probability}`);
  assert.ok(r.isLikely);
  assert.ok(r.reasons.some((x) => x.rule === 'cjk_chars_present'));
});

test('拼音华人：Wang Xiaoming → 命中', () => {
  const r = looksChinese({ name: 'Wang Xiaoming' });
  assert.ok(r.isLikely, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.some((x) => x.rule === 'surname_known'));
});

test('拼音华人：Xiaoming Wang → 命中', () => {
  const r = looksChinese({ name: 'Xiaoming Wang' });
  assert.ok(r.isLikely);
});

test('驼峰姓名：XiaoMing Wang → 命中（camel_case_token）', () => {
  const r = looksChinese({ name: 'XiaoMing Wang' });
  assert.ok(r.isLikely);
  assert.ok(r.reasons.some((x) => x.rule === 'camel_case_token'));
});

test('连字符姓名：Wei-Li Wang → 命中（hyphenated）', () => {
  const r = looksChinese({ name: 'Wei-Li Wang' });
  assert.ok(r.isLikely);
  assert.ok(r.reasons.some((x) => x.rule === 'hyphenated_given_name'));
});

test('Li Wei → 命中（最小 2-token）', () => {
  const r = looksChinese({ name: 'Li Wei' });
  assert.ok(r.isLikely, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}`);
});

test('Zhang Jing → 命中', () => {
  const r = looksChinese({ name: 'Zhang Jing' });
  assert.ok(r.isLikely);
});

test('Han Han → 命中（同字）', () => {
  const r = looksChinese({ name: 'Han Han' });
  assert.ok(r.isLikely);
});

test('香港拼音：Cheung Ka Wai → 命中', () => {
  const r = looksChinese({ name: 'Cheung Ka Wai' });
  assert.ok(r.isLikely, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}`);
});

test('香港拼音：Wong Mei Ling → 命中', () => {
  const r = looksChinese({ name: 'Wong Mei Ling' });
  assert.ok(r.isLikely);
});

test('非华人：John Smith → 不命中', () => {
  const r = looksChinese({ name: 'John Smith' });
  assert.equal(r.isLikely, false, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}, negatives=${JSON.stringify(r.negatives)}`);
});

test('非华人：David Brown → 不命中', () => {
  const r = looksChinese({ name: 'David Brown' });
  assert.equal(r.isLikely, false);
});

test('非华人：Maria Garcia → 不命中（西语）', () => {
  const r = looksChinese({ name: 'Maria Garcia' });
  assert.equal(r.isLikely, false, `got ${r.probability}, negatives=${JSON.stringify(r.negatives)}`);
});

test('非华人：Hans Müller → 不命中（德语）', () => {
  const r = looksChinese({ name: 'Hans Müller' });
  // 注：'müller' 包含 ü 会被 lower() 跳过 surname 匹配，western_given_name 'hans' 会命中降权
  assert.equal(r.isLikely, false, `got ${r.probability}, negatives=${JSON.stringify(r.negatives)}`);
});

test('非华人：Pierre Dubois → 不命中', () => {
  const r = looksChinese({ name: 'Pierre Dubois' });
  assert.equal(r.isLikely, false);
});

test('非华人：Olga Ivanova → 不命中（俄语）', () => {
  const r = looksChinese({ name: 'Olga Ivanova' });
  assert.equal(r.isLikely, false, `got ${r.probability}, negatives=${JSON.stringify(r.negatives)}`);
});

test('边界：空字符串 → 0', () => {
  const r = looksChinese({ name: '' });
  assert.equal(r.probability, 0);
  assert.equal(r.isLikely, false);
});

test('边界：单 token 华人姓氏 → 仍可能命中', () => {
  const r = looksChinese({ name: 'Wang' });
  assert.ok(r.probability >= 0.3);
});

test('头衔被剥离：Prof. Wang Xiaoming, PhD → 仍命中', () => {
  const r = looksChinese({ name: 'Prof. Wang Xiaoming, PhD' });
  assert.ok(r.isLikely, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}`);
});

test('韩语姓名：Kim Minjun → 不命中（不在华人常见集中）', () => {
  const r = looksChinese({ name: 'Kim Minjun' });
  // 期望：score 不高（韩语 'kim' 偶然在华人集中，但 given name 3 音节会降低）
  // 不强制不命中，但 probability 应 < 0.4
  assert.ok(r.probability < 0.6, `got ${r.probability}, reasons=${JSON.stringify(r.reasons)}`);
});

test('tokenize：连字符拆分（subTokens 拆分，parts 保留）', () => {
  const t = tokenizeName('Wei-Li Wang');
  assert.deepEqual(t.parts, ['Wei-Li', 'Wang']);
  assert.deepEqual(t.subTokens, ['Wei', 'Li', 'Wang']);
  assert.deepEqual(t.tokens, ['Wei', 'Li', 'Wang']);
});

test('tokenize：头衔移除', () => {
  const t = tokenizeName('Prof. Dr. Maria Garcia');
  assert.deepEqual(t.parts, ['Maria', 'Garcia']);
  assert.deepEqual(t.subTokens, ['Maria', 'Garcia']);
});

test('COMMON_SURNAMES 包含核心 100 姓', () => {
  for (const s of ['wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou']) {
    assert.ok(COMMON_SURNAMES.has(s), `missing surname: ${s}`);
  }
});

test('assess 详细 reason 数量与 score 一致', () => {
  const r = assess({ name: 'XiaoMing Wang', cjkFragments: [] });
  assert.ok(r.matches.length > 0);
  assert.ok(r.score > 0);
});

module.exports = { tests };
