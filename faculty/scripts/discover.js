#!/usr/bin/env node
// discover.js — 主入口：基于 qs50 入口库抓取教师列表页与个人主页。
//
// 用法：
//   node faculty/scripts/discover.js                  # 默认：--limit 3，dry-run 关闭
//   node faculty/scripts/discover.js --all            # 全部 50 校
//   node faculty/scripts/discover.js --schools 1,7,20 # 指定 rank
//   node faculty/scripts/discover.js --limit 10       # 每个 school 最多处理 10 个部门
//   node faculty/scripts/discover.js --dry-run        # 不发请求，写入样例候选
//   node faculty/scripts/discover.js --out /tmp/out    # 自定义输出目录
//   node faculty/scripts/discover.js --skip-existing  # 断点续跑：跳过 db 中已有且 success 的 (source_kind, source_url)
//   node faculty/scripts/discover.js --verbose        # 详细日志
//
// 退出码：0=ok；1=参数/输入错误；2=部分失败但有进展；3=全部失败。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const sqlite = require('node:sqlite');

const { loadQs50, activeEntries, isKnownCategory } = require('./lib/loader.js');
const { fetchWithRetry, createRateLimiter } = require('./lib/fetch.js');
const { listUrlCandidates, listCandidatesWithHint, scoreListPage, extractProfileLinks, extractInternalLinks, isProfileUrl } = require('./lib/classify.js');
const { extractPersonalInfo, pickBestName } = require('./lib/extract.js');
const { looksChinese } = require('./lib/chinese.js');
const { createStore } = require('./lib/storage.js');
const { htmlRelPath, writeArchive, relToPosix } = require('./lib/files.js');

function parseArgs(argv) {
  const out = { verbose: false, dryRun: false, limit: 3, limitSet: false, schools: null, all: false, out: null, maxProfiles: 200, skipExisting: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--skip-existing') out.skipExisting = true;
    else if (a === '--schools') { out.schools = argv[++i].split(',').map((s) => Number(s.trim())); }
    else if (a === '--limit') { out.limit = Number(argv[++i]); out.limitSet = true; }
    else if (a === '--max-profiles') { out.maxProfiles = Number(argv[++i]); }
    else if (a === '--out') { out.out = argv[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('## 使用')[0] || '');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  // --all 单独出现时把 limit 设为 0（不限）
  if (out.all && !out.limitSet) {
    out.limit = 0;
  }
  return out;
}

function makeLogger(verbose) {
  const log = (...args) => { if (verbose) console.error('[discover]', ...args); };
  return log;
}

function pickEntries(loader, opts) {
  // 同时保留 active 与 non-active，但标记 kind，方便 processDepartment 区分
  let active = activeEntries(loader).map((e) => ({ ...e, _kind: 'active' }));
  let excluded = loader.departments
    .filter((e) => !activeEntries(loader).includes(e))
    .map((e) => ({ ...e, _kind: 'excluded' }));
  let entries = active.concat(excluded);
  if (opts.schools) {
    const set = new Set(opts.schools);
    entries = entries.filter((e) => set.has(e.school_rank));
  }
  // 每所学校最多 opts.limit 个 *active* 部门（--limit 0 表示不限）
  if (opts.limit > 0) {
    const perSchool = new Map();
    entries = entries.filter((e) => {
      if (e._kind !== 'active') return true; // 排除项不过滤
      const c = perSchool.get(e.school_rank) || 0;
      if (c >= opts.limit) return false;
      perSchool.set(e.school_rank, c + 1);
      return true;
    });
  }
  return entries;
}

function candidateId({ kind, sourceUrl }) {
  return crypto.createHash('sha1').update(`${kind}|${sourceUrl}`).digest('hex');
}

async function findListPage({ entry, fetchImpl, rateLimit, log, dryRun, store, skipExisting }) {
  if (dryRun) {
    // dry-run 模式：直接用样例，跳过真实网络
    return { best: dryRunListSample(entry), tried: [] };
  }
  const candidates = listCandidatesWithHint({ entryUrl: entry.url, hint: entry.list_url_hint });
  log(`list candidates for ${entry.department_id}: ${candidates.length}${entry.list_url_hint ? ` (hint=${entry.list_url_hint})` : ''}`);
  const tried = [];
  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const u = candidates[i];
    let parsedHost = '';
    try { parsedHost = new URL(u).host; } catch (_) { /* ignore */ }
    await rateLimit(parsedHost);
    const r = await fetchImpl(u);
    if (!r.ok) {
      tried.push({ url: u, status: r.error || `http_${r.status}`, httpStatus: r.status, error: r.errorDetail });
      continue;
    }
    const html = r.body.toString('utf8');
    const profileLinks = extractProfileLinks(html, u);
    const score = scoreListPage({ html, entryUrl: u, profileLinkCount: profileLinks.length });
    tried.push({ url: u, status: 'ok', httpStatus: r.status, score: score.score, profileLinks: profileLinks.length, reasons: score.reasons });
    // 只在 score > 0 时记 best
    if (score.score > 0 && (!best || score.score > best.score.score)) {
      best = { url: u, httpStatus: r.status, body: html, score, profileLinks, bytes: r.bytes, durationMs: r.durationMs, redirectedTo: r.redirectedTo };
    }
    if (best && best.score.score >= 0.65) break; // 命中阈值后停止
  }
  return { best, tried };
}

function dryRunListSample(entry) {
  const slug = entry.department_id;
  const html = `<!doctype html>
<html><head><title>${entry.department_name_en} | Faculty & People Directory</title></head>
<body>
  <h1>${entry.department_name_en} — Faculty & People</h1>
  <ul class="people-list">
    <li><a href="/${slug}/people/wang-xiaoming">Xiaoming Wang</a> — Assistant Professor of Operations Research</li>
    <li><a href="/${slug}/people/li-wei">Wei Li</a> — Associate Professor, Information Systems</li>
    <li><a href="/${slug}/people/zhang-jing">Jing Zhang</a> — Postdoctoral Researcher, Decision Science</li>
    <li><a href="/${slug}/people/smith-jane">Jane Smith</a> — Senior Lecturer</li>
    <li><a href="/${slug}/people/zhao-meng">Meng Zhao</a> — PhD Student</li>
  </ul>
</body></html>`;
  return {
    url: entry.url,
    httpStatus: 200,
    body: html,
    score: { score: 0.95, reasons: ['dry-run'], internalLinks: [] },
    profileLinks: [
      `${entry.url}/people/wang-xiaoming`,
      `${entry.url}/people/li-wei`,
      `${entry.url}/people/zhang-jing`,
      `${entry.url}/people/smith-jane`,
      `${entry.url}/people/zhao-meng`,
    ],
    bytes: html.length,
    durationMs: 1,
    redirectedTo: null,
  };
}

function dryRunPersonalSample({ entry, profileUrl, idx }) {
  const names = [
    { name: 'Xiaoming Wang', title: 'Assistant Professor of Operations Research', cjk: '王晓明' },
    { name: 'Wei Li', title: 'Associate Professor, Information Systems', cjk: '' },
    { name: 'Jing Zhang', title: 'Postdoctoral Researcher, Decision Science', cjk: '' },
    { name: 'Jane Smith', title: 'Senior Lecturer', cjk: '' },
    { name: 'Meng Zhao', title: 'PhD Student in Management Science', cjk: '赵萌' },
  ];
  const pick = names[idx % names.length];
  const html = `<!doctype html>
<html><head>
  <title>${pick.name} | ${entry.department_name_en}</title>
  <meta name="author" content="${pick.name}">
  <meta name="description" content="${pick.title}">
</head>
<body>
  <h1>${pick.name}</h1>
  <p class="title">${pick.title}</p>
  <p>Email: <a href="mailto:${pick.name.toLowerCase().replace(/\s+/g, '.')}@example.edu">${pick.name.toLowerCase().replace(/\s+/g, '.')}@example.edu</a></p>
  <p>${pick.cjk || ''}</p>
  <p>Bio: PhD from a leading research university. Research interests: optimization, machine learning.</p>
</body></html>`;
  return { name: pick.name, title: pick.title, html };
}

async function processDepartment({ entry, store, fetchImpl, rateLimit, log, opts }) {
  const result = { entry, listOk: false, profileCount: 0, chineseCount: 0, errors: [], skipped: false, skippedExisting: 0 };
  // 0a. 非 active 入口（suspected_irrelevant / access_failed / requires_manual_confirmation）→ 写 skipped 行
  // 预期跳过：不影响 failures 计数、不影响退出码
  if (entry._kind === 'excluded') {
    const reason = entry.status === 'suspected_irrelevant'
      ? 'suspected_irrelevant: school/department not relevant to task; no faculty page to crawl'
      : entry.status === 'access_failed'
        ? 'access_failed: known to fail; skipped'
        : `status=${entry.status}: skipped`;
    store.recordCrawlLog({
      targetKind: 'entry',
      targetUrl: entry.url,
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      status: 'skipped',
      errorDetail: reason,
    });
    store.recordDepartmentSummary({
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      departmentNameEn: entry.department_name_en,
      entryUrl: entry.url,
      category: entry.category,
      needsJsHint: !!entry.needs_js_hint,
      status: entry.status,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: 'skipped',
    });
    result.skipped = true;
    return result;
  }
  // 0b. needs_js 跳过（标记为 requires_js）— 同样为预期跳过
  if (entry.needs_js_hint && !opts.dryRun) {
    store.recordCrawlLog({
      targetKind: 'entry',
      targetUrl: entry.url,
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      status: 'requires_js',
      errorDetail: 'needs_js_hint=true; deferred to headless run',
    });
    store.recordDepartmentSummary({
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      departmentNameEn: entry.department_name_en,
      entryUrl: entry.url,
      category: entry.category,
      needsJsHint: true,
      status: entry.status,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: 'requires_js',
    });
    result.skipped = true;
    return result;
  }

  // 1. 找 list 页面
  const { best, tried } = await findListPage({ entry, fetchImpl, rateLimit, log, dryRun: opts.dryRun });
  for (const t of tried) {
    store.recordCrawlLog({
      targetKind: 'list_page_candidate',
      targetUrl: t.url,
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      httpStatus: t.httpStatus,
      status: t.status === 'ok' ? 'success' : t.status,
      errorDetail: t.error || null,
    });
  }
  if (!best) {
    store.recordDepartmentSummary({
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      departmentNameEn: entry.department_name_en,
      entryUrl: entry.url,
      category: entry.category,
      needsJsHint: !!entry.needs_js_hint,
      status: entry.status,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: 'no_faculty_page',
    });
    // no_list_page：active 入口但没找到教师页 — 计为真 failure
    result.errors.push('no_list_page');
    return result;
  }
  // 写 list 页
  const listArchive = writeArchive({
    fs,
    dataDir: opts.dataDir,
    schoolRank: entry.school_rank,
    schoolName: entry.school_name_en,
    departmentId: entry.department_id,
    kind: 'list_page',
    sourceUrl: best.url,
    body: Buffer.from(best.body, 'utf8'),
    indexHint: 0,
  });
  const listRel = relToPosix(path.relative(opts.dataDir, listArchive.absPath));
  store.recordCandidate({
    id: candidateId({ kind: 'list_page', sourceUrl: best.url }),
    schoolRank: entry.school_rank,
    schoolNameEn: entry.school_name_en,
    departmentId: entry.department_id,
    departmentNameEn: entry.department_name_en,
    category: entry.category,
    sourceKind: 'list_page',
    sourceUrl: best.url,
    sourceListUrl: null,
    localPath: listRel,
    nameRaw: null,
    titleRaw: 'faculty list page',
    emailRaw: null,
    chineseNameProbability: 0,
    chineseNameReasons: [],
    reviewStatus: 'pending',
    crawlStatus: 'success',
  });
  result.listOk = true;
  result.listUrl = best.url;

  // 2. 从 list 抽取 profile 链接，抓个人主页
  const profileUrls = best.profileLinks.filter(isProfileUrl);
  const limited = profileUrls.slice(0, opts.maxProfiles);
  log(`profiles for ${entry.department_id}: ${profileUrls.length}, fetching first ${limited.length}`);
  for (let i = 0; i < limited.length; i += 1) {
    const profileUrl = limited[i];
    // --skip-existing：profile URL 已在 db 中且上轮 success → 不发请求、不落库
    if (opts.skipExisting && store.getCandidateStatus('personal_page', profileUrl) === 'success') {
      result.skippedExisting += 1;
      log(`skip-existing: ${profileUrl}`);
      continue;
    }
    let host = '';
    try { host = new URL(profileUrl).host; } catch (_) { /* ignore */ }
    await rateLimit(host);
    let html; let httpStatus; let bytes; let durationMs; let redirectedTo = null; let crawlStatus; let errorDetail = null;
    if (opts.dryRun) {
      const sample = dryRunPersonalSample({ entry, profileUrl, idx: i });
      html = sample.html;
      httpStatus = 200;
      bytes = html.length;
      durationMs = 1;
      crawlStatus = 'success';
    } else {
      const r = await fetchImpl(profileUrl);
      if (!r.ok) {
        crawlStatus = r.error || `http_${r.status}`;
        errorDetail = r.errorDetail || null;
        httpStatus = r.status || null;
        store.recordCrawlLog({
          targetKind: 'personal_page',
          targetUrl: profileUrl,
          schoolRank: entry.school_rank,
          departmentId: entry.department_id,
          httpStatus,
          bytes: 0,
          durationMs: r.durationMs || 0,
          status: crawlStatus,
          errorDetail,
          redirectedTo: r.redirectedTo || null,
        });
        continue;
      }
      html = r.body.toString('utf8');
      httpStatus = r.status;
      bytes = r.bytes;
      durationMs = r.durationMs;
      redirectedTo = r.redirectedTo;
      crawlStatus = 'success';
    }
    const info = extractPersonalInfo({ html, url: profileUrl });
    // 写归档
    const arch = writeArchive({
      fs,
      dataDir: opts.dataDir,
      schoolRank: entry.school_rank,
      schoolName: entry.school_name_en,
      departmentId: entry.department_id,
      kind: 'personal_page',
      sourceUrl: profileUrl,
      body: Buffer.from(html, 'utf8'),
    });
    const rel = relToPosix(path.relative(opts.dataDir, arch.absPath));
    // BRA-15 (v2.2)：姓名兜底。h1 > og:title > meta author > title 清洗（识别 NOT_FOUND 模板）> URL slug
    const namePick = pickBestName({ meta: { __h1: info.h1, __title: info.title, 'og:title': info.meta.ogTitle, author: info.meta.author }, url: profileUrl });
    const nameRaw = namePick.value;
    log(`name for ${profileUrl}: source=${namePick.source} value=${nameRaw}`);
    const titleRaw = info.titleKeyword || null;
    const emailRaw = info.emails[0] || null;
    const cjk = info.cjkFragments;
    const cn = looksChinese({ name: nameRaw, cjkFragments: cjk });
    store.recordCandidate({
      id: candidateId({ kind: 'personal_page', sourceUrl: profileUrl }),
      schoolRank: entry.school_rank,
      schoolNameEn: entry.school_name_en,
      departmentId: entry.department_id,
      departmentNameEn: entry.department_name_en,
      category: entry.category,
      sourceKind: 'personal_page',
      sourceUrl: profileUrl,
      sourceListUrl: best.url,
      localPath: rel,
      nameRaw,
      titleRaw,
      emailRaw,
      chineseNameProbability: cn.probability,
      chineseNameReasons: cn.reasons,
      reviewStatus: 'pending',
      crawlStatus,
    });
    store.recordCrawlLog({
      targetKind: 'personal_page',
      targetUrl: profileUrl,
      schoolRank: entry.school_rank,
      departmentId: entry.department_id,
      httpStatus,
      bytes,
      durationMs,
      status: crawlStatus,
      errorDetail,
      redirectedTo,
    });
    result.profileCount += 1;
    if (cn.isLikely) result.chineseCount += 1;
  }
  // 3. 部门汇总
  const counts = store.getDeptCounts(entry.school_rank, entry.department_id);
  store.recordDepartmentSummary({
    schoolRank: entry.school_rank,
    departmentId: entry.department_id,
    departmentNameEn: entry.department_name_en,
    entryUrl: entry.url,
    category: entry.category,
    needsJsHint: !!entry.needs_js_hint,
    status: entry.status,
    discoveredListUrl: result.listUrl,
    listPagesCount: 1,
    candidatesCount: counts.total,
    candidatesChsCount: counts.chinese,
    lastRunAt: new Date().toISOString(),
    lastRunStatus: result.profileCount > 0 ? 'ok' : 'no_profiles',
  });
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = makeLogger(opts.verbose);
  const root = process.cwd();
  let loader;
  try {
    loader = loadQs50({ root });
  } catch (err) {
    console.error('loader error:', err.message);
    process.exit(1);
  }
  const dataDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(root, 'faculty', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore({ dataDir, sqlite, logger: console });
  store.setMeta('schema_version', '1.0');
  store.setMeta('last_run_at', new Date().toISOString());
  store.setMeta('dry_run', String(!!opts.dryRun));
  store.setMeta('argv', JSON.stringify(process.argv.slice(2)));

  const runOpts = { ...opts, dataDir };
  const entries = pickEntries(loader, runOpts);
  log(`selected ${entries.length} entries to process`);

  const fetchImpl = opts.dryRun
    ? async () => ({ ok: true, status: 200, body: Buffer.from(''), bytes: 0, durationMs: 0, redirectedTo: null })
    : (url) => fetchWithRetry(url, { retries: 1, baseDelayMs: 300, timeoutMs: 12000 });
  const rateLimit = createRateLimiter(opts.dryRun ? 0 : 1500);

  let processed = 0;
  let withList = 0;
  let profiles = 0;
  let chinese = 0;
  let failures = 0;
  let skipped = 0;
  let skippedExisting = 0;
  for (const entry of entries) {
    try {
      log(`processing ${entry.school_rank}/${entry.department_id} → ${entry.url}`);
      const r = await processDepartment({ entry, store, fetchImpl, rateLimit, log, opts: runOpts });
      processed += 1;
      if (r.skipped) { skipped += 1; continue; } // 预期跳过不算 failure
      if (r.listOk) withList += 1;
      profiles += r.profileCount;
      chinese += r.chineseCount;
      skippedExisting += r.skippedExisting || 0;
      if (r.errors.length) failures += 1;
    } catch (err) {
      failures += 1;
      console.error(`[FAIL] ${entry.department_id}: ${err.message}`);
      store.recordCrawlLog({
        targetKind: 'entry',
        targetUrl: entry.url,
        schoolRank: entry.school_rank,
        departmentId: entry.department_id,
        status: 'error',
        errorDetail: err.message,
      });
    }
  }

  store.setMeta('last_finished_at', new Date().toISOString());
  store.setMeta('last_processed', String(processed));
  store.setMeta('last_with_list', String(withList));
  store.setMeta('last_profiles', String(profiles));
  store.setMeta('last_chinese', String(chinese));
  store.setMeta('last_skipped', String(skipped));
  store.setMeta('last_skipped_existing', String(skippedExisting));
  store.setMeta('last_failures', String(failures));
  store.setMeta('skip_existing', String(!!opts.skipExisting));
  store.close();

  // 退出码语义：
  //   0 = 全部 processed，无真 failure（可能含 skipped 预期跳过）
  //   1 = 参数/输入错误（已在 loader 失败分支处理）
  //   2 = 有真 failure（active 入口 no_list_page / 抛错等）
  //   3 = 没有匹配到任何 entry
  console.log(JSON.stringify({
    ok: true,
    processed,
    withList,
    profiles,
    chinese,
    skipped,
    skippedExisting,
    failures,
    dataDir,
  }, null, 2));
  if (failures > 0 && processed > 0) process.exit(2);
  if (processed === 0) process.exit(3);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, pickEntries, processDepartment, findListPage };
