#!/usr/bin/env node
// papers.js — 主入口：期刊论文 API 查询 + 华人姓名高召回初筛（BRA-9）。
//
// 用法：
//   node faculty/scripts/papers.js --all                          # 处理所有 51 本期刊
//   node faculty/scripts/papers.js --systems 中文期刊,英文期刊      # 按体系过滤
//   node faculty/scripts/papers.js --levels A+,A                  # 按学校级别过滤
//   node faculty/scripts/papers.js --limit 5                      # 最多 5 本期刊
//   node faculty/scripts/papers.js --max-papers 100               # 单刊最多 100 篇
//   node faculty/scripts/papers.js --chinese-threshold 0.4        # 华人初筛阈值
//   node faculty/scripts/papers.js --dry-run                      # 不发请求，注入样例 works
//   node faculty/scripts/papers.js --fallback crossref            # OpenAlex 失败后用 Crossref 兜底（默认开启）
//   node faculty/scripts/papers.js --out /tmp/bra9                # 自定义输出
//   node faculty/scripts/papers.js --csv path/to/journals.csv     # 自定义 CSV
//   node faculty/scripts/papers.js --verbose
//
// 退出码：
//   0 = 全部期刊都成功落库（success / no_results 都算成功，failed / api_unsupported 计入 exit 2）
//   1 = 参数错误 / CSV 不存在 / faculty.db 不存在
//   2 = 至少一本期刊出现真 failure（api_unsupported / failed / error），输出 JSON 中 failures > 0
//   3 = 过滤后没有任何期刊被选中
//
// 输出：标准 JSON 到 stdout，包含 journals / papers / authors / targetCandidates / failures / skipped

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('./lib/storage.js');
const { parseJournalsCsv } = require('./lib/papers_csv.js');
const { createOpenAlex } = require('./lib/openalex.js');
const { createCrossref } = require('./lib/crossref.js');
const { extractAuthorships, extractPaperRecord } = require('./lib/paper_extract.js');

function parseArgs(argv) {
  const out = {
    verbose: false,
    dryRun: false,
    all: false,
    systems: null,
    levels: null,
    limit: 0,
    maxPapers: 0,
    chineseThreshold: 0.4,
    fallback: true,
    fallbackMode: 'crossref',
    out: null,
    csv: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--systems') out.systems = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--levels') out.levels = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--max-papers') out.maxPapers = Number(argv[++i]);
    else if (a === '--chinese-threshold') out.chineseThreshold = Number(argv[++i]);
    else if (a === '--no-fallback') out.fallback = false;
    else if (a === '--fallback') out.fallbackMode = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--csv') out.csv = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node faculty/scripts/papers.js [--all] [--systems S1,S2] [--levels L1,L2] [--limit N] [--max-papers N] [--chinese-threshold T] [--fallback crossref] [--no-fallback] [--csv PATH] [--out DIR] [--dry-run] [--verbose]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function makeLogger(verbose) {
  return (...args) => { if (verbose) console.error('[papers]', ...args); };
}

function pickJournals(rows, opts) {
  let out = rows.slice();
  if (opts.systems && opts.systems.length) {
    const set = new Set(opts.systems);
    out = out.filter((r) => r.journalSystem && set.has(r.journalSystem));
  }
  if (opts.levels && opts.levels.length) {
    const set = new Set(opts.levels);
    out = out.filter((r) => r.schoolLevel && set.has(r.schoolLevel));
  }
  if (opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

// 把中文期刊名映射成 OpenAlex 可解析的形式
// 例如 "管理世界" -> 暂用期刊名原文；OpenAlex 主要按 ISSN 解析，中文期刊基本无 ISSN（CN 号）
// OpenAlex 找不到时记录 api_unsupported；Crossref 同样无 CN → 记 api_unsupported
function isApiUnsupported(journal) {
  // OpenAlex 与 Crossref 都按 ISSN 解析；CN-only 中文期刊（无 print-ISSN）一律不可解
  if (!journal.issnPrint) return true;
  return false;
}

// dry-run 注入的样例 works（每本期刊 ~ 2 篇混合名字）
// 用 OpenAlex 原始字段名（publication_year / publication_date）以便走 normalizeWork
const DRYRUN_SAMPLE = (journal) => ([
  {
    id: `https://openalex.org/W${dryHash(journal.id + 'p1').slice(0, 8)}`,
    doi: `10.1234/dryrun.${dryHash(journal.id + 'p1').slice(0, 6)}`,
    title: `[dryrun] Sample paper 1 in ${journal.journalNameRaw}`,
    publication_year: 2023,
    publication_date: '2023-04-15',
    language: 'en',
    type: 'article',
    cited_by_count: 0,
    primary_location: { source: { id: `S${dryHash(journal.id).slice(0, 9)}`, issn_l: journal.issnPrint, display_name: journal.journalNameRaw } },
    biblio: { volume: '1', issue: '1', first_page: '1', last_page: '20' },
    authorships: [
      { author: { display_name: 'Wang Xiaoming' }, position: 'first', is_corresponding: false,
        raw_affiliation_string: 'Tsinghua University', institutions: [{ id: 'I123', display_name: 'Tsinghua University' }] },
      { author: { display_name: 'Li Wei' }, position: 'middle', is_corresponding: true,
        raw_affiliation_string: 'Peking University', institutions: [{ id: 'I456', display_name: 'Peking University' }] },
      { author: { display_name: 'John Smith' }, position: 'last', is_corresponding: false,
        raw_affiliation_string: 'MIT', institutions: [{ id: 'I789', display_name: 'MIT' }] },
    ],
  },
  {
    id: `https://openalex.org/W${dryHash(journal.id + 'p2').slice(0, 8)}`,
    doi: `10.1234/dryrun.${dryHash(journal.id + 'p2').slice(0, 6)}`,
    title: `[dryrun] Sample paper 2 in ${journal.journalNameRaw}`,
    publication_year: 2024,
    publication_date: '2024-09-20',
    language: 'en',
    type: 'article',
    cited_by_count: 0,
    primary_location: { source: { id: `S${dryHash(journal.id).slice(0, 9)}`, issn_l: journal.issnPrint, display_name: journal.journalNameRaw } },
    biblio: { volume: '2', issue: '3', first_page: '100', last_page: '120' },
    authorships: [
      { author: { display_name: '陈晓' }, position: 'first', is_corresponding: true,
        raw_affiliation_string: '上海交通大学', institutions: [{ id: 'I111', display_name: 'Shanghai Jiao Tong University' }] },
      { author: { display_name: 'Zhang Ling' }, position: 'last', is_corresponding: false,
        raw_affiliation_string: 'Fudan University', institutions: [{ id: 'I222', display_name: 'Fudan University' }] },
    ],
  },
]);

function dryHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h) + s.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function processJournal({ journal, oa, cr, store, opts, log }) {
  const start = Date.now();
  // 1. 写 journal 记录（状态 pending）
  store.recordJournal({
    ...journal,
    queryStatus: 'pending',
    lastQueryAt: new Date().toISOString(),
  });

  // 2. API 不支持：无 ISSN/CN（中文期刊 CN 号 OpenAlex/Crossref 都不支持）
  if (isApiUnsupported(journal)) {
    store.recordJournal({
      ...journal,
      queryStatus: 'api_unsupported',
      lastQueryAt: new Date().toISOString(),
      errorDetail: 'journal has no ISSN; OpenAlex/Crossref cannot resolve by CN-only',
    });
    log(`[api_unsupported] ${journal.journalNameRaw}`);
    return { journal, status: 'api_unsupported', papers: 0, targetCandidates: 0 };
  }

  // 3. OpenAlex 解析 source ID
  let oaSource = null;
  let openalexError = null;
  if (!opts.dryRun) {
    oaSource = await oa.findSourceByIssn(journal.issnPrint);
    if (oaSource && oaSource._error) {
      openalexError = oaSource._error;
      oaSource = null;
    }
  } else {
    oaSource = { id: `S${dryHash(journal.id).slice(0, 9)}`, issn_l: journal.issnPrint, display_name: journal.journalNameRaw };
  }

  let workSource = 'openalex';
  let crossrefJournal = null;
  let crossrefError = null;
  if (!oaSource && !opts.dryRun) {
    // OpenAlex 找不到 → Crossref 兜底
    if (opts.fallback && opts.fallbackMode === 'crossref') {
      crossrefJournal = await cr.findJournal(journal.issnPrint);
      if (crossrefJournal && crossrefJournal._error) {
        crossrefError = crossrefJournal._error;
        crossrefJournal = null;
      }
      if (crossrefJournal) {
        workSource = 'crossref';
      }
    }
  }

  if (!oaSource && !crossrefJournal) {
    const errDetail = openalexError
      ? `openalex: ${openalexError.error} ${openalexError.status || ''} ${(openalexError.errorDetail || '').slice(0, 200)}`
      : 'openalex returned 0 results';
    store.recordJournal({
      ...journal,
      queryStatus: 'no_results',
      lastQueryAt: new Date().toISOString(),
      errorDetail: errDetail,
    });
    log(`[no_results] ${journal.journalNameRaw} — ${errDetail}`);
    return { journal, status: 'no_results', papers: 0, targetCandidates: 0 };
  }

  // 4. 拉 paper 列表（每页回调里逐条入库）
  let papersFound = 0;
  let papersKept = 0;
  let authorsFound = 0;
  let authorsChs = 0;
  let targetCandidates = 0;
  let lastError = null;

  async function onPage({ results }) {
    for (const raw of results) {
      papersFound += 1;
      if (opts.maxPapers > 0 && papersKept >= opts.maxPapers) return;
      const work = workSource === 'openalex' ? oa.normalizeWork(raw) : cr.normalizeWork(raw);
      if (!work) continue;
      // 时间范围二次过滤（API 也已限制，兜底）
      const yr = work.publish_year;
      if (yr !== null && yr !== undefined && (yr < 2021 || yr > 2026)) continue;
      const paperRec = extractPaperRecord({
        work,
        journalId: journal.id,
        journalName: journal.journalNameRaw,
        source: workSource,
        issn: work.issn_l || journal.issnPrint,
      });
      if (!paperRec) continue;
      store.recordPaper(paperRec);
      papersKept += 1;
      const authorships = extractAuthorships({
        work,
        paperId: paperRec.id,
        threshold: opts.chineseThreshold,
      });
      for (const a of authorships) {
        store.recordPaperAuthor(a);
        authorsFound += 1;
        if (a.chineseNameProbability >= opts.chineseThreshold) authorsChs += 1;
        if (a.isTargetCandidate) targetCandidates += 1;
      }
    }
  }

  let iterResult = { ok: true, pages: 0, total: 0 };
  if (opts.dryRun) {
    // 干跑：用注入的样例 works（DRYRUN_SAMPLE）直接走 onPage，不发任何网络请求
    const samples = DRYRUN_SAMPLE(journal);
    for (const raw of samples) {
      await onPage({ page: 1, results: [raw], raw: { results: samples, meta: { next_cursor: null } } });
    }
    iterResult = { ok: true, pages: 1, total: samples.length };
  } else if (oaSource) {
    iterResult = await oa.iterateWorks({
      sourceId: oaSource.id,
      from: '2021-01-01',
      until: '2026-06-03',
      type: 'article',
      onPage,
      maxPages: opts.maxPapers > 0 ? Math.ceil(opts.maxPapers / 200) + 1 : 200,
      perPage: 200,
    });
  } else if (crossrefJournal) {
    iterResult = await cr.iterateWorks({
      issn: journal.issnPrint,
      from: '2021-01-01',
      until: '2026-06-03',
      type: 'journal-article',
      onPage,
      maxPages: opts.maxPapers > 0 ? Math.ceil(opts.maxPapers / 200) + 1 : 100,
      rows: 200,
    });
  }
  if (!iterResult.ok) {
    lastError = `${iterResult.error}${iterResult.status ? ` (HTTP ${iterResult.status})` : ''}: ${(iterResult.errorDetail || '').slice(0, 200)}`;
  }

  // 5. 写 journal 终态
  let finalStatus;
  if (!iterResult.ok && papersKept === 0) {
    finalStatus = 'failed';
  } else if (papersKept === 0) {
    finalStatus = 'no_results';
  } else {
    finalStatus = 'success';
  }

  store.recordJournal({
    ...journal,
    openalexSourceId: oaSource ? oaSource.id : null,
    journalNameEn: oaSource ? oaSource.display_name : (crossrefJournal ? crossrefJournal.title || null : null),
    issnL: (oaSource && oaSource.issn_l) || journal.issnPrint,
    issnPrint: journal.issnPrint,
    issnElectronic: (oaSource && oaSource.issn_electronic) || null,
    crossrefIssn: crossrefJournal && workSource === 'crossref' ? journal.issnPrint : null,
    queryStatus: finalStatus,
    papersFound,
    papersKept,
    authorsFound,
    authorsChs,
    authorsTarget: targetCandidates,
    lastQueryAt: new Date().toISOString(),
    errorDetail: lastError,
  });

  // 6. 写一条 crawl_log 记录
  store.recordCrawlLog({
    targetKind: 'journal',
    targetUrl: oaSource ? `https://api.openalex.org/sources/${oaSource.id}` : `https://api.crossref.org/journals/${journal.issnPrint}`,
    schoolRank: null,
    departmentId: null,
    httpStatus: null,
    bytes: null,
    durationMs: Date.now() - start,
    status: finalStatus,
    errorDetail: lastError,
    redirectedTo: null,
  });

  log(`[${finalStatus}] ${journal.journalNameRaw}: papers ${papersKept}/${papersFound}, target-candidates ${targetCandidates} (${authorsChs} chinese)`);
  return { journal, status: finalStatus, papers: papersKept, targetCandidates, authorsChs, lastError };
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = makeLogger(opts.verbose);

  const dataDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 1. 读 CSV
  const csvPath = opts.csv
    ? path.resolve(opts.csv)
    : path.resolve(__dirname, '..', 'data', 'journals.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`journals.csv not found at ${csvPath}; use --csv to specify`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const { rows: journals, errors: csvErrors } = parseJournalsCsv(csvText);
  if (csvErrors.length > 0) {
    console.error(`CSV parse warnings: ${csvErrors.length}`);
    for (const e of csvErrors.slice(0, 5)) console.error(`  line ${e.lineNumber}: ${e.message}`);
  }
  if (journals.length === 0) {
    console.error('no journals parsed from CSV');
    process.exit(1);
  }
  log(`parsed ${journals.length} journals from CSV`);

  // 2. 过滤
  const selected = pickJournals(journals, opts);
  if (selected.length === 0) {
    console.error('no journals matched filters');
    process.exit(3);
  }
  log(`selected ${selected.length} journals`);

  // 3. 打开 store
  const store = createStore({ dataDir, sqlite });

  // 4. API 客户端
  const oa = createOpenAlex({ logger: log });
  const cr = createCrossref();

  // 5. 逐本期刊处理
  const results = [];
  for (const journal of selected) {
    try {
      const r = await processJournal({ journal, oa, cr, store, opts, log });
      results.push(r);
    } catch (err) {
      log(`[error] ${journal.journalNameRaw}: ${err.message}`);
      store.recordJournal({
        ...journal,
        queryStatus: 'failed',
        lastQueryAt: new Date().toISOString(),
        errorDetail: err.message.slice(0, 1000),
      });
      results.push({ journal, status: 'failed', error: err.message, papers: 0, targetCandidates: 0 });
    }
  }

  // 6. 汇总
  const stats = store.getJournalStats();
  const realFailures = results.filter((r) => r.status === 'failed');
  const apiUnsupported = results.filter((r) => r.status === 'api_unsupported');
  const summary = {
    journals_selected: selected.length,
    journals_by_status: stats.journal_status,
    papers_total: stats.papers.total_papers,
    papers_in_range: stats.papers.in_range,
    authors_total: stats.authors.total_authors,
    authors_chinese_likely: stats.authors.chinese_likely,
    authors_target_candidates: stats.authors.target_candidates,
    failures: realFailures.length,
    api_unsupported: apiUnsupported.length,
    failures_detail: realFailures.map((r) => ({
      journal: r.journal.journalNameRaw,
      status: r.status,
      detail: r.lastError || r.error || null,
    })),
    api_unsupported_detail: apiUnsupported.map((r) => ({
      journal: r.journal.journalNameRaw,
      cn: r.journal.cnCode || null,
    })),
    journals: results.map((r) => ({
      name: r.journal.journalNameRaw,
      issn: r.journal.issnPrint,
      cn: r.journal.cnCode,
      status: r.status,
      papers: r.papers,
      targetCandidates: r.targetCandidates,
      authorsChs: r.authorsChs || 0,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));

  store.close();

  // 退出码
  if (realFailures.length > 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
