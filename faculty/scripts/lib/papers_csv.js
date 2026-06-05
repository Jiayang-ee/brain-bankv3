// papers_csv.js — 解析附件期刊清单 CSV（管理科学与工程相关期刊筛选清单）。
//
// 原始字段（8 列）：
//   来源文件 / 期刊体系 / 学科/方向 / 期刊名称 / ISSN/CN / 学校级别 / 人才库用途 / 备注
//
// CSV 文件含 UTF-8 BOM（"\uFEFF"），用 slice(1) 去掉。
// 引号转义：双引号内 "" 表示一个字面量双引号。
// 仅在"非中文期刊"的 ISSN/CN 列视为 8 位 ISSN（带或不带 -），其他情况是 CN 号（11-1235/F 等）。
//
// 公开：
//   - parseJournalsCsv(text) → { rows, errors }
//   - canonicalIssn(s) → 8 位去横线
//   - canonicalCn(s) → 形如 "11-1235/F" 规范化
//   - journalId({ sourceFile, name, issn, cn }) → sha1 hex

'use strict';

const crypto = require('node:crypto');

// CSV 字段切分：处理双引号包字段 + "" 转义
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else { inQuote = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// 规范化为 8 位去横线 / 空格（仅当输入看起来像 ISSN）
function canonicalIssn(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[\s-]/g, '').toUpperCase();
  // 必须形如 4字母+3字母 或 4数字+3字母（hybrid ISSN-L）
  if (/^[0-9X]{4}[A-Z0-9]{3}[A-Z0-9]?$/.test(s) && s.length === 8) {
    return s;
  }
  return null;
}

function canonicalCn(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{2}-\d{4}\/[A-Z]\d*$/.test(s)) return s;
  return null;
}

function looksLikeIssn(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  return /^[0-9X]{4}-?[0-9X]{3}[0-9X]?$/i.test(s);
}

function looksLikeCn(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  return /^\d{2}-\d{4}\/[A-Z]\d*$/i.test(s);
}

function journalId({ sourceFile, name, issn, cn }) {
  const key = [sourceFile || '', name || '', issn || '', cn || ''].join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

// 简单 RFC3339-ish ISO 时间
function nowIso() { return new Date().toISOString(); }

// 解析整个 CSV 文本。
// text: 完整 CSV（含表头）。
// 返回 { rows, errors }：
//   rows = [{ id, sourceFile, journalSystem, discipline, journalNameRaw, issnRaw,
//             issnPrint, cnCode, schoolLevel, usage, notes, firstSeenAt, lastSeenAt }, ...]
//   errors = [{ lineNumber, raw, message }]
function parseJournalsCsv(text) {
  const errors = [];
  if (!text) return { rows: [], errors: [{ lineNumber: 0, raw: '', message: 'empty text' }] };
  // 去掉 BOM
  const cleaned = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = cleaned.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: [{ lineNumber: 0, raw: '', message: 'no lines' }] };
  const header = splitCsvLine(lines[0]);
  const expected = ['来源文件', '期刊体系', '学科/方向', '期刊名称', 'ISSN/CN', '学校级别', '人才库用途', '备注'];
  if (header.length < expected.length) {
    errors.push({ lineNumber: 1, raw: lines[0], message: `header has ${header.length} cols, expected ${expected.length}` });
  }
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = splitCsvLine(lines[i]);
    if (fields.length < 4) {
      errors.push({ lineNumber: i + 1, raw: lines[i], message: `only ${fields.length} fields, skipped` });
      continue;
    }
    const [
      sourceFile, journalSystem, discipline, journalName, issnRaw,
      schoolLevel, usage, notes,
    ] = fields;
    if (!journalName) {
      errors.push({ lineNumber: i + 1, raw: lines[i], message: 'empty journal name' });
      continue;
    }
    let issnPrint = null;
    let cnCode = null;
    if (looksLikeIssn(issnRaw)) {
      issnPrint = canonicalIssn(issnRaw);
    } else if (looksLikeCn(issnRaw)) {
      cnCode = canonicalCn(issnRaw);
    }
    const ts = nowIso();
    rows.push({
      id: journalId({ sourceFile, name: journalName, issn: issnPrint, cn: cnCode }),
      sourceFile: sourceFile || '',
      journalSystem: journalSystem || null,
      discipline: discipline || null,
      journalNameRaw: journalName,
      issnRaw: issnRaw || null,
      issnPrint,
      issnElectronic: null,    // CSV 不区分；解析阶段由 OpenAlex/Crossref 补
      issnL: issnPrint,         // 初始假设 linking = print
      cnCode,
      schoolLevel: schoolLevel || null,
      usage: usage || null,
      notes: notes || null,
      firstSeenAt: ts,
      lastSeenAt: ts,
    });
  }
  return { rows, errors };
}

module.exports = {
  parseJournalsCsv,
  splitCsvLine,
  canonicalIssn,
  canonicalCn,
  looksLikeIssn,
  looksLikeCn,
  journalId,
};
