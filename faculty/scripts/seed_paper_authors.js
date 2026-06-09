#!/usr/bin/env node
// scripts/seed_paper_authors.js — 给 faculty.db 注入若干 paper / paper_author 样例
// （仅用于 BRA-10 演示。BRA-9 真实跑批会从 OpenAlex / Crossref 落库。）
//
// 用法： node faculty/scripts/seed_paper_authors.js [--db PATH]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('./lib/storage.js');

function parseArgs(argv) {
  const out = { db: null, count: 20 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node faculty/scripts/seed_paper_authors.js [--db PATH] [--count N]');
      process.exit(0);
    } else { console.error(`unknown: ${a}`); process.exit(1); }
  }
  return out;
}

function defaultDb() {
  return path.join(process.cwd(), 'faculty', 'data', 'faculty.db');
}

const SURNAMES = ['Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Wu', 'Zhou', 'Sun', 'Xu', 'Ma', 'Zhu', 'Hu', 'Lin'];
const GIVEN = ['Xiaoming', 'Wei', 'Lei', 'Jing', 'Hao', 'Yan', 'Bo', 'Ming', 'Jian', 'Yu', 'Hua', 'Qiang'];
const SCHOOLS = ['MIT', 'Stanford', 'Tsinghua', 'Peking University', 'Berkeley', 'CMU', 'Georgia Tech'];
const JOURNALS = [
  { id: 'j-mgmt-sci', name: 'Management Science', issn: '0025-1909' },
  { id: 'j-pom', name: 'Production and Operations Management', issn: '1059-1478' },
  { id: 'j-ijpe', name: 'International Journal of Production Economics', issn: '0925-5273' },
  { id: 'j-nature', name: 'Nature', issn: '0028-0836' },
  { id: 'j-pnas', name: 'PNAS', issn: '0027-8424' },
];

function pickName(i) {
  return `${SURNAMES[i % SURNAMES.length]} ${GIVEN[(i * 3) % GIVEN.length]}`;
}

function main() {
  const opts = parseArgs(process.argv);
  const dbPath = path.resolve(opts.db || defaultDb());
  if (!fs.existsSync(dbPath)) {
    console.error(`faculty.db not found: ${dbPath}`);
    process.exit(1);
  }

  const store = createStore({ dataDir: path.dirname(dbPath), sqlite });
  const now = new Date().toISOString();

  // 期刊
  for (const j of JOURNALS) {
    store.recordJournal({
      id: j.id,
      sourceFile: 'seed',
      journalSystem: '英文期刊',
      journalNameRaw: j.name,
      journalNameEn: j.name,
      issnRaw: j.issn,
      issnPrint: j.issn,
      queryStatus: 'success',
    });
  }

  // paper + paper_authors
  for (let i = 0; i < opts.count; i += 1) {
    const journal = JOURNALS[i % JOURNALS.length];
    const paperId = `seed-paper-${i}`;
    const title = `A study of ${journal.name} submission #${i}: operations research and chinese scholars`;
    store.recordPaper({
      id: paperId,
      doi: `10.1234/seed-${i}`,
      title,
      journalId: journal.id,
      journalName: journal.name,
      issn: journal.issn,
      publishYear: 2021 + (i % 6),
      publishDate: `${2021 + (i % 6)}-06-15`,
      source: 'openalex',
      sourceUrl: `https://api.openalex.org/W${i}`,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    // 2-3 authors per paper
    const nAuthors = 2 + (i % 2);
    for (let k = 0; k < nAuthors; k += 1) {
      const position = k;
      const isFirst = k === 0 ? 1 : 0;
      const isLast = k === nAuthors - 1 ? 1 : 0;
      const isCorr = (k === 0 || k === nAuthors - 1) ? 1 : 0;
      // 华人概率递增：first/last 更高
      const isTarget = (isFirst || isLast || isCorr) ? 1 : 0;
      const chs = isTarget ? 0.55 + (i % 4) * 0.1 : 0.2;
      const authorName = pickName(i + k);
      store.recordPaperAuthor({
        id: `seed-pa-${i}-${k}`,
        paperId,
        authorName,
        authorPosition: position,
        isFirstAuthor: isFirst,
        isLastAuthor: isLast,
        isCorresponding: isCorr,
        affiliationRaw: SCHOOLS[(i + k) % SCHOOLS.length],
        affiliationId: SCHOOLS[(i + k) % SCHOOLS.length].toLowerCase().replace(/\s+/g, '-'),
        affiliationName: SCHOOLS[(i + k) % SCHOOLS.length],
        orcid: null,
        chineseNameProbability: Math.min(1, chs),
        chineseNameReasons: [{ rule: 'surname_known', detail: authorName.split(' ')[0].toLowerCase() }],
        chineseNameNegatives: [],
        isTargetCandidate: isTarget,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }

  store.close();
  console.log(`✓ seeded ${opts.count} papers (${JOURNALS.length} journals) → ${dbPath}`);
}

main();
