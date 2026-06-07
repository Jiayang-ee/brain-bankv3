#!/usr/bin/env node
// validate.js — 校验 faculty/data/faculty.db + JSONL 文件的内部一致性。
// 用法： node faculty/scripts/validate.js [--out <dir>]
// 退出码：0=ok；1=失败

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

function parseOutArg(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') return argv[i + 1];
  }
  return null;
}

const DATA_DIR = parseOutArg(process.argv)
  ? path.resolve(parseOutArg(process.argv))
  : path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'faculty.db');
const REQUIRED_CATEGORIES = new Set([
  'business_school', 'management_school',
  'engineering_management', 'industrial_engineering', 'systems_engineering',
  'operations_research', 'decision_science', 'information_systems',
  'business_analytics', 'public_policy',
]);

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
}

(function main() {
  if (!fs.existsSync(DB_PATH)) {
    fail(`faculty.db not found at ${DB_PATH}; run discover.js first`);
    return;
  }
  const db = new sqlite.DatabaseSync(DB_PATH);

  // ---- 部门汇总：50/50 覆盖 ----
  const ranks = new Set();
  const seenRanks = db.prepare('SELECT DISTINCT school_rank FROM department_summary');
  for (const r of seenRanks.all()) ranks.add(r.school_rank);
  if (ranks.size < 50) {
    fail(`department_summary covers only ${ranks.size}/50 schools; re-run with --all to seed`);
  } else {
    console.log(`- department_summary covers ${ranks.size} schools`);
  }

  // ---- 候选人：source_url 唯一 ----
  const dupes = db.prepare(`
    SELECT source_kind, source_url, COUNT(*) AS n
    FROM candidates
    GROUP BY source_kind, source_url
    HAVING n > 1
  `).all();
  if (dupes.length > 0) {
    fail(`candidate duplicates: ${dupes.length}`);
    for (const d of dupes.slice(0, 5)) console.error(`   ${d.source_kind} ${d.source_url} x${d.n}`);
  } else {
    console.log('- candidates: no duplicate (source_kind, source_url)');
  }

  // ---- category 枚举 ----
  const badCategory = db.prepare(`
    SELECT DISTINCT category FROM candidates
    WHERE category NOT IN (${[...REQUIRED_CATEGORIES].map(() => '?').join(',')})
  `).all();
  if (badCategory.length > 0) {
    fail(`unknown category in candidates: ${badCategory.map((r) => r.category).join(', ')}`);
  }

  // ---- crawl_log 状态分布 ----
  const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM crawl_log GROUP BY status ORDER BY n DESC`).all();
  console.log(`- crawl_log status distribution: ${JSON.stringify(Object.fromEntries(statusRows.map((r) => [r.status, r.n])))}`);

  // ---- headshot 抓取状态分布（BRA-8） ----
  const headshotRows = db.prepare(`
    SELECT headshot_crawl_status AS status, COUNT(*) AS n
    FROM candidates
    WHERE source_kind = 'personal_page' AND headshot_crawl_status IS NOT NULL
    GROUP BY headshot_crawl_status
    ORDER BY n DESC
  `).all();
  if (headshotRows.length > 0) {
    console.log(`- headshot status distribution: ${JSON.stringify(Object.fromEntries(headshotRows.map((r) => [r.status, r.n])))}`);
  } else {
    console.log(`- headshot status distribution: (no personal_page candidates have been processed; run photos.js)`);
  }

  // ---- headshot 一致性抽样校验（BRA-8） ----
  const headshotOk = db.prepare(`
    SELECT headshot_local_path
    FROM candidates
    WHERE source_kind = 'personal_page' AND headshot_crawl_status = 'success' AND headshot_local_path IS NOT NULL
    LIMIT 20
  `).all();
  let headshotMissing = 0;
  for (const r of headshotOk) {
    if (!r.headshot_local_path) continue;
    const p = path.join(DATA_DIR, r.headshot_local_path);
    if (!fs.existsSync(p)) {
      headshotMissing += 1;
      if (headshotMissing <= 3) console.error(`   headshot file missing: ${r.headshot_local_path}`);
    }
  }
  if (headshotMissing > 0) {
    fail(`headshot files missing: ${headshotMissing}/${headshotOk.length}`);
  } else if (headshotOk.length > 0) {
    console.log(`- headshot files present: ${headshotOk.length}/${headshotOk.length}`);
  }

  // ---- 总体统计 ----
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM candidates) AS candidates,
      (SELECT COUNT(*) FROM candidates WHERE chinese_name_probability >= 0.4) AS chinese_likely,
      (SELECT COUNT(*) FROM department_summary) AS departments,
      (SELECT COUNT(DISTINCT school_rank) FROM department_summary) AS schools,
      (SELECT COUNT(*) FROM crawl_log) AS crawl_events
  `).get();
  console.log(`- totals: ${JSON.stringify(totals)}`);

  // ---- 每个 QS 排名至少 1 个 department_summary 行 ----
  if (totals.schools < 50) {
    fail(`schools covered = ${totals.schools}/50`);
  } else {
    console.log(`- school coverage: ${totals.schools}/50 (OK)`);
  }

  // ---- jsonl 文件存在且可解析 ----
  for (const name of ['candidates.jsonl', 'crawl_log.jsonl']) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      try { JSON.parse(line); } catch (_) { bad += 1; }
    }
    if (bad > 0) fail(`${name}: ${bad}/${lines.length} invalid JSONL rows`);
    else console.log(`- ${name}: ${lines.length} rows valid`);
  }

  // ---- BRA-9: 期刊 / 论文 / 论文作者 ----
  const hasJournalsTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='journals'
  `).get();
  if (hasJournalsTable) {
    const jCount = db.prepare('SELECT COUNT(*) AS n FROM journals').get().n;
    console.log(`- BRA-9 journals table: ${jCount} rows`);
    if (jCount === 0) {
      console.log('  (run papers.js --all to seed the journals/papers/paper_authors tables)');
    } else {
      const jStats = db.prepare(`
        SELECT query_status, COUNT(*) AS n
        FROM journals
        GROUP BY query_status
        ORDER BY n DESC
      `).all();
      console.log(`  status: ${JSON.stringify(Object.fromEntries(jStats.map((r) => [r.query_status, r.n])))}`);
      const apiUnsupported = db.prepare(`
        SELECT COUNT(*) AS n FROM journals
        WHERE query_status = 'api_unsupported'
      `).get().n;
      const noIssn = db.prepare(`
        SELECT COUNT(*) AS n FROM journals
        WHERE issn_print IS NULL OR issn_print = ''
      `).get().n;
      if (noIssn !== apiUnsupported) {
        fail(`journals with no ISSN (${noIssn}) != api_unsupported (${apiUnsupported}); every CN-only journal should be marked api_unsupported`);
      }
      const hasP = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='papers'
      `).get();
      if (hasP) {
        const pCount = db.prepare('SELECT COUNT(*) AS n FROM papers').get().n;
        const pInRange = db.prepare(`
          SELECT COUNT(*) AS n FROM papers
          WHERE publish_year IS NOT NULL AND publish_year >= 2021 AND publish_year <= 2026
        `).get().n;
        console.log(`  papers: ${pCount} total, ${pInRange} in 2021-2026 range`);
        const orphanPapers = db.prepare(`
          SELECT COUNT(*) AS n FROM papers p
          LEFT JOIN journals j ON j.id = p.journal_id
          WHERE j.id IS NULL
        `).get().n;
        if (orphanPapers > 0) fail(`orphan papers (no matching journal): ${orphanPapers}`);

        const hasPA = db.prepare(`
          SELECT name FROM sqlite_master WHERE type='table' AND name='paper_authors'
        `).get();
        if (hasPA) {
          const aCount = db.prepare('SELECT COUNT(*) AS n FROM paper_authors').get().n;
          const chs = db.prepare(`
            SELECT COUNT(*) AS n FROM paper_authors
            WHERE chinese_name_probability >= 0.4
          `).get().n;
          const target = db.prepare(`
            SELECT COUNT(*) AS n FROM paper_authors
            WHERE is_target_candidate = 1
          `).get().n;
          console.log(`  paper_authors: ${aCount} total, ${chs} chinese_likely, ${target} target_candidates`);
          const orphanAuthors = db.prepare(`
            SELECT COUNT(*) AS n FROM paper_authors pa
            LEFT JOIN papers p ON p.id = pa.paper_id
            WHERE p.id IS NULL
          `).get().n;
          if (orphanAuthors > 0) fail(`orphan paper_authors (no matching paper): ${orphanAuthors}`);
          if (target > 0) {
            const chsCheck = db.prepare(`
              SELECT COUNT(*) AS n FROM paper_authors
              WHERE is_target_candidate = 1
                AND (is_first_author = 1 OR is_last_author = 1 OR is_corresponding = 1)
                AND chinese_name_probability >= 0.4
            `).get().n;
            if (chsCheck !== target) {
              fail(`target_candidate consistency: ${target} flagged, ${chsCheck} match (first/last/corresponding AND chinese>=0.4)`);
            }
          }
          // BRA-9.1: 邮箱 enrich 校验
          const hasEmailCols = db.prepare(`
            SELECT name FROM pragma_table_info('paper_authors') WHERE name = 'email_raw'
          `).get();
          if (hasEmailCols && aCount > 0) {
            const emailWithRaw = db.prepare(`
              SELECT COUNT(*) AS n FROM paper_authors
              WHERE email_raw IS NOT NULL AND email_raw != ''
            `).get().n;
            const emailPct = aCount > 0 ? (emailWithRaw / aCount) * 100 : 0;
            console.log(`  emails: ${emailWithRaw} with email_raw (${emailPct.toFixed(2)}% of ${aCount} authors)`);
            // 覆盖率检查：>= 1% 视为路径 A 兜底达标（与 BRA-9.1 验收标准一致）
            if (emailPct < 1.0) {
              fail(`email coverage ${emailPct.toFixed(2)}% < 1% target (path A: openalex regex fallback)`);
            } else {
              console.log(`  email coverage: ${emailPct.toFixed(2)}% (>= 1% OK)`);
            }
            // 邮箱格式校验：所有非空 email_raw 必须满足 isValidEmail 规则
            const VALID_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
            const badEmails = db.prepare(`
              SELECT id, email_raw, email_source FROM paper_authors
              WHERE email_raw IS NOT NULL AND email_raw != ''
                AND email_raw NOT GLOB '*@*.*'
            `).all();
            // GLOB 粗筛：必须有 @ 和至少一个 .
            if (badEmails.length > 0) {
              fail(`emails missing @ or TLD: ${badEmails.length}`);
              for (const b of badEmails.slice(0, 5)) {
                console.error(`   ${b.id} email=${JSON.stringify(b.email_raw)} source=${b.email_source}`);
              }
            }
            // 用正则严格校验
            const sample = db.prepare(`
              SELECT email_raw FROM paper_authors
              WHERE email_raw IS NOT NULL AND email_raw != ''
              LIMIT 500
            `).all();
            const invalidFormat = sample.filter((r) => !VALID_EMAIL_RE.test(r.email_raw));
            if (invalidFormat.length > 0) {
              fail(`emails with invalid format: ${invalidFormat.length}/${sample.length}`);
              for (const e of invalidFormat.slice(0, 5)) {
                console.error(`   ${JSON.stringify(e.email_raw)}`);
              }
            }
            // 邮箱长度上限
            const tooLong = db.prepare(`
              SELECT id, email_raw FROM paper_authors
              WHERE email_raw IS NOT NULL AND length(email_raw) > 254
            `).all();
            if (tooLong.length > 0) {
              fail(`emails > 254 chars: ${tooLong.length}`);
            }
            // 黑名单域校验
            const REJECTED_DOMAINS = [
              'example.com', 'example.org', 'example.net', 'example.edu',
              'test.com', 'test.org', 'test.edu',
              'noreply.com', 'no-reply.com', 'noreply.org', 'noreply.edu',
              'localhost', 'localhost.localdomain',
              'email.com', 'yourcompany.com', 'yourdomain.com',
            ];
            const blacklistCheck = db.prepare(`
              SELECT id, email_raw FROM paper_authors
              WHERE email_raw IS NOT NULL
            `).all();
            const blacklistHits = blacklistCheck.filter((r) => {
              const atIdx = r.email_raw.indexOf('@');
              if (atIdx < 1) return false;
              const domain = r.email_raw.slice(atIdx + 1).toLowerCase();
              return REJECTED_DOMAINS.includes(domain);
            });
            if (blacklistHits.length > 0) {
              fail(`emails from blacklisted domains: ${blacklistHits.length}`);
              for (const b of blacklistHits.slice(0, 5)) {
                console.error(`   ${b.id} email=${JSON.stringify(b.email_raw)}`);
              }
            }
            // email_source 枚举校验
            // 生产合法值 5 个（与 lib/email_extract.js VALID_SOURCES 对齐）。
            // 2 个 spike 候选值（crossref_work_meta / openaire_meta）3a spike 关停
            // 后不在这里启用；如未来重新激活，需同时改此处 + lib/email_extract.js
            // + email_extract.test.js 长度断言 + schema v1.5 文档，4 处同步升级。
            const VALID_SOURCES = [
              'openalex_regex', 'publisher_wiley', 'publisher_elsevier', 'orcid_public_api', 'manual',
            ];
            const badSource = db.prepare(`
              SELECT DISTINCT email_source FROM paper_authors
              WHERE email_source IS NOT NULL
                AND email_source NOT IN (${VALID_SOURCES.map(() => '?').join(',')})
            `).all(...VALID_SOURCES);
            if (badSource.length > 0) {
              fail(`unknown email_source values: ${badSource.map((r) => r.email_source).join(', ')}`);
            } else {
              const sourceDist = db.prepare(`
                SELECT email_source, COUNT(*) AS n FROM paper_authors
                WHERE email_source IS NOT NULL
                GROUP BY email_source
                ORDER BY n DESC
              `).all();
              console.log(`  email_source distribution: ${JSON.stringify(Object.fromEntries(sourceDist.map((r) => [r.email_source, r.n])))}`);
            }
          }
        }
      }
    }
  } else {
    console.log('- BRA-9 journals table: (not yet created; run papers.js --all to seed)');
  }

  // ---- BRA-9: 期刊/论文 JSONL 文件存在且可解析 ----
  for (const name of ['journals.jsonl', 'papers.jsonl', 'paper_authors.jsonl']) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      try { JSON.parse(line); } catch (_) { bad += 1; }
    }
    if (bad > 0) fail(`${name}: ${bad}/${lines.length} invalid JSONL rows`);
    else console.log(`- ${name}: ${lines.length} rows valid`);
  }

  // ---- BRA-9.2: ORCID enrich 校验 ----
  const hasOrcidCols = db.prepare(`
    SELECT name FROM pragma_table_info('paper_authors') WHERE name = 'email_orcid_id'
  `).get();
  if (hasOrcidCols) {
    const orcidWith = db.prepare(`
      SELECT
        SUM(CASE WHEN email_orcid_id IS NOT NULL AND email_orcid_id != '' THEN 1 ELSE 0 END) AS with_orcid_id,
        SUM(CASE WHEN orcid_last_fetched IS NOT NULL THEN 1 ELSE 0 END) AS fetched,
        SUM(CASE WHEN email_source = 'orcid_public_api' THEN 1 ELSE 0 END) AS sourced
      FROM paper_authors
    `).get();
    console.log(`- ORCID enrich: ${orcidWith.with_orcid_id || 0} with email_orcid_id, ${orcidWith.fetched || 0} fetched, ${orcidWith.sourced || 0} email_source=orcid_public_api`);

    // BRA-9.3: ORCID profile 覆盖率 KPI（替代 email 命中率）
    //   covered  = orcid_affiliations_json IS NOT NULL 的行（拿到 affiliations profile 字段）
    //   queried  = orcid_last_fetched IS NOT NULL 的行（已查询过的作者）
    //   门槛 50%：低于则 fail（与 schema v1.5 验收标准对齐）
    const orcidProfileCov = db.prepare(`
      SELECT
        SUM(CASE WHEN orcid_last_fetched IS NOT NULL THEN 1 ELSE 0 END) AS queried,
        SUM(CASE WHEN orcid_last_fetched IS NOT NULL
                  AND orcid_affiliations_json IS NOT NULL
                  AND orcid_affiliations_json != '' THEN 1 ELSE 0 END) AS covered
      FROM paper_authors
      WHERE chinese_name_probability >= 0.4
        AND (is_first_author = 1 OR is_corresponding = 1)
        AND orcid IS NOT NULL AND orcid <> ''
    `).get();
    const queried = orcidProfileCov.queried || 0;
    const covered = orcidProfileCov.covered || 0;
    if (queried > 0) {
      const pct = ((covered / queried) * 100).toFixed(1);
      console.log(`- ORCID profile 覆盖率: ${covered}/${queried} = ${pct}% (门槛 50%)`);
      if (covered / queried < 0.5) {
        fail(`ORCID profile 覆盖率 ${pct}% < 50% 门槛`);
      }
    } else {
      console.log('- ORCID profile 覆盖率: (尚无 ORCID 查询行; 跑 orcid_enrich.js 后再校验)');
    }

    // email_orcid_id 格式校验：必须是 0000-0000-0000-0000 或末位 X
    const ORCID_ID_RE = /^\d{4}-\d{4}-\d{4}-[\dX]{4}$/;
    const badOrcidIds = db.prepare(`
      SELECT id, email_orcid_id FROM paper_authors
      WHERE email_orcid_id IS NOT NULL AND email_orcid_id != ''
        AND email_orcid_id NOT GLOB '????-????-????-????'
    `).all();
    if (badOrcidIds.length > 0) {
      fail(`email_orcid_id missing dash format: ${badOrcidIds.length}`);
      for (const b of badOrcidIds.slice(0, 5)) {
        console.error(`   ${b.id} email_orcid_id=${JSON.stringify(b.email_orcid_id)}`);
      }
    }
    const badOrcidFormat = db.prepare(`
      SELECT email_orcid_id FROM paper_authors
      WHERE email_orcid_id IS NOT NULL AND email_orcid_id != ''
    `).all().filter((r) => !ORCID_ID_RE.test(r.email_orcid_id));
    if (badOrcidFormat.length > 0) {
      fail(`email_orcid_id format invalid: ${badOrcidFormat.length}`);
      for (const b of badOrcidFormat.slice(0, 5)) {
        console.error(`   ${JSON.stringify(b.email_orcid_id)}`);
      }
    }

    // email_orcid_id 与 email_source 一致性：source='orcid_public_api' 的行 email_orcid_id 必须非空且形如 ORCID
    const inconsistentOrcidSource = db.prepare(`
      SELECT id, email_orcid_id, email_source FROM paper_authors
      WHERE email_source = 'orcid_public_api'
        AND (email_orcid_id IS NULL OR email_orcid_id = ''
             OR email_orcid_id NOT GLOB '????-????-????-????')
    `).all();
    if (inconsistentOrcidSource.length > 0) {
      fail(`email_source=orcid_public_api but email_orcid_id missing/invalid: ${inconsistentOrcidSource.length}`);
      for (const r of inconsistentOrcidSource.slice(0, 5)) {
        console.error(`   ${r.id} email_orcid_id=${JSON.stringify(r.email_orcid_id)} source=${r.email_source}`);
      }
    } else {
      const sourced = orcidWith.sourced || 0;
      if (sourced > 0) console.log(`  email_source / email_orcid_id consistency: OK (${sourced} rows)`);
    }

    // 3 个 JSON 列必须可解析
    for (const col of ['orcid_external_ids_json', 'orcid_affiliations_json', 'orcid_profile_json']) {
      const badJson = db.prepare(`
        SELECT id FROM paper_authors
        WHERE ${col} IS NOT NULL AND ${col} != ''
          AND json_valid(${col}) = 0
      `).all();
      if (badJson.length > 0) {
        fail(`${col}: ${badJson.length}/${db.prepare(`SELECT COUNT(*) AS n FROM paper_authors WHERE ${col} IS NOT NULL AND ${col} != ''`).get().n} invalid JSON`);
      } else {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM paper_authors WHERE ${col} IS NOT NULL AND ${col} != ''`).get().n;
        if (n > 0) console.log(`  ${col}: ${n} rows, all valid JSON`);
      }
    }

    // 成功 (200) 的行 OR 字段都非空；404 沉默返回的行 profile_json 必为 NULL（设计上接受）
    // 注意：orcid_last_modified 是 ORCID API 响应头（Last-Modified），不是所有 profile 都带，所以允许 NULL
    const fetchedRowMissingFields = db.prepare(`
      SELECT id FROM paper_authors
      WHERE orcid_last_fetched IS NOT NULL
        AND orcid_profile_json IS NOT NULL AND orcid_profile_json != ''
        AND (email_orcid_id IS NULL OR email_orcid_id = '')
    `).all();
    if (fetchedRowMissingFields.length > 0) {
      fail(`orcid_last_fetched set but email_orcid_id missing (200 行): ${fetchedRowMissingFields.length}`);
      for (const r of fetchedRowMissingFields.slice(0, 5)) {
        console.error(`   ${r.id}`);
      }
    }
    // 404 沉默返回行：last_fetched 写了但 profile_json 必为 NULL（不算错）
    const silenceRows = db.prepare(`
      SELECT id FROM paper_authors
      WHERE orcid_last_fetched IS NOT NULL
        AND (orcid_profile_json IS NULL OR orcid_profile_json = '')
    `).all();
    if (silenceRows.length > 0) {
      console.log(`- orcid 404 沉默行: ${silenceRows.length}（profile_json 必为 NULL，符合设计）`);
    }

    // orcid_query_log.jsonl 可解析
    const orcidLogPath = path.join(DATA_DIR, 'orcid_query_log.jsonl');
    if (fs.existsSync(orcidLogPath)) {
      const lines = fs.readFileSync(orcidLogPath, 'utf8').split('\n').filter(Boolean);
      let bad = 0;
      for (const line of lines) {
        try { JSON.parse(line); } catch (_) { bad += 1; }
      }
      if (bad > 0) fail(`orcid_query_log.jsonl: ${bad}/${lines.length} invalid JSONL rows`);
      else console.log(`- orcid_query_log.jsonl: ${lines.length} rows valid`);
    }
  } else {
    console.log('- ORCID enrich: (not yet created; run orcid_enrich.js to seed)');
  }

  if (process.exitCode === 1) console.error('\nVALIDATION FAILED');
  else console.log('\nVALIDATION OK');
  db.close();
})();
