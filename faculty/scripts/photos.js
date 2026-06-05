#!/usr/bin/env node
// photos.js — 主入口：从已抓取的 personal_page 候选人中下载头像。
//
// 流程：
//   1. 读 faculty.db 选出 source_kind='personal_page' AND crawl_status='success' 的候选人
//   2. 读归档的本地 HTML（personal_page 的 local_path）
//   3. 抽取照片 URL（og:image / twitter:image / <img class=...headshot...> 等）
//   4. 下载照片 → 落盘到 html/.../photo/<sha1[0:8]><.ext>
//   5. 写回 headshot_* 字段 + crawl_log（target_kind='headshot'）
//
// 退出码：
//   0 = 完成（含 no_photo / 失败等，详见输出 JSON）
//   1 = 参数错误 / loadQs50 失败 / faculty.db 不存在
//   2 = 至少一个 headshot 出现真 failure（如 http_error/format_unsupported/anti_leech）
//
// 不修改候选人是否入库；无照片或失败仅写 headshot_crawl_status，不影响 candidates 主表。
//
// 用法：
//   node faculty/scripts/photos.js --all
//   node faculty/scripts/photos.js --schools 1,2,20
//   node faculty/scripts/photos.js --all --limit 5
//   node faculty/scripts/photos.js --all --max-profiles 100
//   node faculty/scripts/photos.js --all --dry-run           # 不发请求，写入 1 个 fake photo
//   node faculty/scripts/photos.js --all --out /tmp/fo        # 自定义输出目录
//   node faculty/scripts/photos.js --all --force             # 重新跑已 success 的（更新原图）
//   node faculty/scripts/photos.js --all --verbose

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('./lib/storage.js');
const { fetchWithRetry, createRateLimiter } = require('./lib/fetch.js');
const {
  PHOTO_STATUS,
  extractPhotoCandidates,
  selectBestPhoto,
  inferExtension,
  inferPhotoStatus,
  isImageContentType,
  photoRelPath,
  writePhoto,
} = require('./lib/photos.js');

function parseArgs(argv) {
  const out = {
    verbose: false,
    dryRun: false,
    limit: 0, // 0 = 不限
    schools: null,
    all: false,
    out: null,
    maxProfiles: 100000, // 0 = 不限
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--schools') out.schools = argv[++i].split(',').map((s) => Number(s.trim()));
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--max-profiles') out.maxProfiles = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node faculty/scripts/photos.js [--all] [--schools r1,r2] [--limit N] [--max-profiles N] [--out DIR] [--dry-run] [--force] [--verbose]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function makeLogger(verbose) {
  return (...args) => { if (verbose) console.error('[photos]', ...args); };
}

function buildFakePhotoPng() {
  // 1x1 透明 PNG（67 字节）+ 0xFE 填充到 ~2KB，模拟真实头像体量（> 100B 阈值）
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  // 填充到 2KB：模拟真实头像像素数据；不写为合法 PNG，仅满足体量检查
  const pad = Buffer.alloc(2000 - png.length, 0xfe);
  return Buffer.concat([png, pad]);
}

function dryRunSamplePersonalHtml(candidate) {
  // 模拟一个 personal page，内嵌 og:image 与 <img class="headshot">
  const base = candidate.source_url || 'https://example.edu/people/x';
  const slug = candidate.id ? candidate.id.slice(0, 6) : 'dryrun';
  return `<!doctype html>
<html><head>
  <title>${slug} | Sample Personal Page</title>
  <meta property="og:image" content="${base}/photos/${slug}.jpg">
</head>
<body>
  <h1>${slug}</h1>
  <img class="headshot profile-photo" src="${base}/photos/${slug}.jpg" alt="${slug} headshot" width="200" height="200">
  <p>Bio text ...</p>
</body></html>`;
}

function makeDryRunFetchImpl(fakePngBuffer) {
  // 仅放行以 /photos/ 结尾的 URL；其它 404
  return async (url) => {
    if (/\/photos\//.test(url) && /\.(jpe?g|png|webp|gif)$/i.test(url)) {
      return {
        ok: true, status: 200,
        headers: { 'content-type': 'image/png' },
        body: fakePngBuffer,
        finalUrl: url,
        contentType: 'image/png',
        bytes: fakePngBuffer.length,
        durationMs: 1,
        redirectedTo: null,
      };
    }
    return { ok: false, error: 'http_error', status: 404, bytes: 0, durationMs: 1, errorDetail: 'dry-run 404' };
  };
}

async function processCandidate({ cand, store, fetchImpl, rateLimit, opts, log }) {
  const result = {
    id: cand.id,
    schoolRank: cand.school_rank,
    departmentId: cand.department_id,
    sourceUrl: cand.source_url,
    status: null,
    headshotUrl: null,
    localPath: null,
    bytes: 0,
    errorDetail: null,
  };

  // 1. 读 HTML
  let html;
  const htmlAbs = cand.local_path ? path.join(opts.dataDir, cand.local_path) : null;
  if (htmlAbs && fs.existsSync(htmlAbs)) {
    html = fs.readFileSync(htmlAbs, 'utf8');
  } else if (opts.dryRun) {
    // dry-run 兜底：本地 HTML 缺失时用样例 HTML（用于离线验收）
    html = dryRunSamplePersonalHtml(cand);
  } else {
    result.status = PHOTO_STATUS.SKIPPED;
    result.errorDetail = `local HTML missing: ${cand.local_path}`;
    store.recordHeadshot({
      id: cand.id,
      headshotCrawlStatus: PHOTO_STATUS.SKIPPED,
      headshotErrorDetail: result.errorDetail,
      headshotFetchedAt: new Date().toISOString(),
    });
    store.recordCrawlLog({
      targetKind: 'headshot',
      targetUrl: cand.source_url,
      schoolRank: cand.school_rank,
      departmentId: cand.department_id,
      status: PHOTO_STATUS.SKIPPED,
      errorDetail: result.errorDetail,
    });
    return result;
  }

  // 2. 抽照片候选
  const cands = extractPhotoCandidates(html, cand.source_url);
  const best = selectBestPhoto(cands);
  if (!best) {
    result.status = PHOTO_STATUS.NO_PHOTO;
    result.errorDetail = 'no extractable photo from HTML';
    store.recordHeadshot({
      id: cand.id,
      headshotCrawlStatus: PHOTO_STATUS.NO_PHOTO,
      headshotErrorDetail: result.errorDetail,
      headshotFetchedAt: new Date().toISOString(),
    });
    store.recordCrawlLog({
      targetKind: 'headshot',
      targetUrl: cand.source_url,
      schoolRank: cand.school_rank,
      departmentId: cand.department_id,
      status: PHOTO_STATUS.NO_PHOTO,
      errorDetail: result.errorDetail,
    });
    return result;
  }
  result.headshotUrl = best.url;
  log(`candidate ${cand.id}: best photo ${best.url} (${best.source}, score=${best.score.toFixed(2)})`);

  // 3. 下载
  let host = '';
  try { host = new URL(best.url).host; } catch (_) { /* ignore */ }
  await rateLimit(host);
  const r = await fetchImpl(best.url);

  // 4. 推断状态
  const status = inferPhotoStatus({
    ok: r.ok, status: r.status, error: r.error, contentType: r.contentType, bytes: r.bytes,
  });
  result.status = status;
  result.errorDetail = r.errorDetail || null;

  if (status !== PHOTO_STATUS.SUCCESS) {
    store.recordHeadshot({
      id: cand.id,
      headshotUrl: best.url,
      headshotCrawlStatus: status,
      headshotErrorDetail: r.errorDetail || `${r.status || ''} ${r.error || ''}`.trim(),
      headshotFetchedAt: new Date().toISOString(),
      headshotSourceUrl: cand.source_url,
    });
    store.recordCrawlLog({
      targetKind: 'headshot',
      targetUrl: best.url,
      schoolRank: cand.school_rank,
      departmentId: cand.department_id,
      httpStatus: r.status,
      bytes: r.bytes || 0,
      durationMs: r.durationMs || 0,
      status,
      errorDetail: r.errorDetail || null,
      redirectedTo: r.redirectedTo || null,
    });
    return result;
  }

  // 5. 落盘
  const ext = inferExtension({ url: best.url, contentType: r.contentType }) || 'bin';
  const arch = writePhoto({
    fs,
    dataDir: opts.dataDir,
    schoolRank: cand.school_rank,
    schoolName: cand.school_name_en,
    departmentId: cand.department_id,
    sourceUrl: cand.source_url,
    photoUrl: best.url,
    contentType: r.contentType,
    body: r.body,
    ext,
  });
  const rel = arch.relPath.split(path.sep).join('/');
  result.localPath = rel;
  result.bytes = r.body.length;

  store.recordHeadshot({
    id: cand.id,
    headshotUrl: best.url,
    headshotLocalPath: rel,
    headshotContentType: r.contentType || null,
    headshotBytes: r.body.length,
    headshotCrawlStatus: PHOTO_STATUS.SUCCESS,
    headshotFetchedAt: new Date().toISOString(),
    headshotSourceUrl: cand.source_url,
  });
  store.recordCrawlLog({
    targetKind: 'headshot',
    targetUrl: best.url,
    schoolRank: cand.school_rank,
    departmentId: cand.department_id,
    httpStatus: r.status,
    bytes: r.body.length,
    durationMs: r.durationMs || 0,
    status: PHOTO_STATUS.SUCCESS,
    redirectedTo: r.redirectedTo || null,
  });
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = makeLogger(opts.verbose);
  const root = process.cwd();
  const dataDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(root, 'faculty', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(path.join(dataDir, 'faculty.db'))) {
    console.error(`faculty.db not found at ${path.join(dataDir, 'faculty.db')}; run discover.js first`);
    process.exit(1);
  }
  const store = createStore({ dataDir, sqlite, logger: console });
  store.setMeta('photos_schema_version', '1.0');
  store.setMeta('photos_last_run_at', new Date().toISOString());
  store.setMeta('photos_dry_run', String(!!opts.dryRun));
  store.setMeta('photos_argv', JSON.stringify(process.argv.slice(2)));

  const runOpts = { ...opts, dataDir };

  const fetchImpl = opts.dryRun
    ? makeDryRunFetchImpl(buildFakePhotoPng())
    : (url) => fetchWithRetry(url, { retries: 1, baseDelayMs: 300, timeoutMs: 12000 });
  const rateLimit = createRateLimiter(opts.dryRun ? 0 : 1500);

  // 选候选人
  let processed = 0;
  let success = 0;
  let noPhoto = 0;
  let failed = 0;
  let skipped = 0;
  const statusDist = {};

  for (const schoolRank of (opts.schools || [null])) {
    const limit = (opts.all || opts.schools) ? (opts.maxProfiles || 100000) : Math.min(opts.limit || 1, 1) * 200;
    const rows = store.selectPhotoCandidates({
      schoolRank,
      onlyPending: !opts.force,
      force: opts.force,
      limit: opts.maxProfiles > 0 ? opts.maxProfiles : 100000,
    });
    log(`school ${schoolRank ?? '*'}: ${rows.length} candidates selected`);

    for (const cand of rows) {
      try {
        const r = await processCandidate({ cand, store, fetchImpl, rateLimit, opts: runOpts, log });
        processed += 1;
        statusDist[r.status] = (statusDist[r.status] || 0) + 1;
        if (r.status === PHOTO_STATUS.SUCCESS) success += 1;
        else if (r.status === PHOTO_STATUS.NO_PHOTO) noPhoto += 1;
        else if (r.status === PHOTO_STATUS.SKIPPED) skipped += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        statusDist[PHOTO_STATUS.ERROR] = (statusDist[PHOTO_STATUS.ERROR] || 0) + 1;
        console.error(`[FAIL] ${cand.id}: ${err.message}`);
        store.recordCrawlLog({
          targetKind: 'headshot',
          targetUrl: cand.source_url,
          schoolRank: cand.school_rank,
          departmentId: cand.department_id,
          status: PHOTO_STATUS.ERROR,
          errorDetail: err.message,
        });
      }
    }
  }

  store.setMeta('photos_last_finished_at', new Date().toISOString());
  store.setMeta('photos_last_processed', String(processed));
  store.setMeta('photos_last_success', String(success));
  store.setMeta('photos_last_no_photo', String(noPhoto));
  store.setMeta('photos_last_failed', String(failed));
  store.setMeta('photos_last_skipped', String(skipped));
  store.close();

  console.log(JSON.stringify({
    ok: true,
    processed,
    success,
    noPhoto,
    failed,
    skipped,
    statusDistribution: statusDist,
    dataDir,
  }, null, 2));

  // 退出码：失败计入真 failure
  if (failed > 0 && processed > 0) process.exit(2);
  if (processed === 0) process.exit(3);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, processCandidate, buildFakePhotoPng, dryRunSamplePersonalHtml };
