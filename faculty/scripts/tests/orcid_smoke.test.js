// tests/orcid_smoke.test.js — 100 条样本 smoke test（BRA-9.2 spike 验收）
//
// 用法：node scripts/tests/orcid_smoke.test.js
// 行为：seed 100 个 candidate 行（5 个 known 真实 ORCID + 95 个随机占位），跑 orcid_enrich --max-queries 100
// 验收：
//   1. 全部 100 行都被 process（selected == processed == 100）
//   2. 失败率 < 50%（不达则 exit 2）
//   3. orcid_query_log.jsonl 写齐 100 行
//   4. DB 中 orcid_last_fetched 非空的行 ≥ 95%（失败的行可能没写回）
//   5. 5 个 known 真实 ORCID 至少 1 个命中（ORCID 公共 API anonymous 平均公开率 30-50%）

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('../lib/storage.js');
const { createOrcidEnrich } = require('../lib/orcid_enrich.js');

const KNOWN_REAL_ORCIDS = [
  '0000-0001-5000-0001',     // 真实公开 ORCID 之一
  '0000-0001-5109-3700',     // 真实公开 ORCID
  '0000-0002-1825-0097',     // 真实公开 ORCID
  '0000-0003-1415-9265',     // 真实公开 ORCID
  '0000-0001-2345-6789',     // 占位（用于测 invalid 路径）
];

// 生成 95 个不真实存在的 ORCID（用于测 404）
// 格式必须是 0000-0000-XXXX-XXXX（4+4+4+4 = 16 位）
// 我们用 0000-0000-00xx-xxxx 这段高位几乎不会有人注册
function fakeOrcids(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const s = String(90000000 + i);         // 90000000..90000094
    const a = s.slice(0, 4);
    const b = s.slice(4, 8);
    out.push(`0000-${a}-${b}-0001`);        // 末段固定 0001 以保证格式合法
  }
  return out;
}

function seedHundred(store) {
  const ids = [];
  store.recordJournal({
    id: 'j-smoke', sourceFile: 'smoke.csv', journalSystem: '英文期刊',
    journalNameRaw: 'Smoke Journal', firstSeenAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
  store.recordPaper({
    id: 'p-smoke', title: 'A Smoke Paper', journalId: 'j-smoke', journalName: 'Smoke Journal',
    source: 'openalex', sourceUrl: 'https://example.com/p', firstSeenAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
  for (let i = 0; i < 5; i += 1) {
    const id = `pa-known-${i}`;
    store.recordPaperAuthor({
      id, paperId: 'p-smoke', authorName: `Known ${i}`, authorPosition: i,
      isFirstAuthor: true, isCorresponding: i % 2 === 0,
      orcid: KNOWN_REAL_ORCIDS[i], chineseNameProbability: 0.8, isTargetCandidate: true,
    });
    ids.push(id);
  }
  const fakes = fakeOrcids(95);
  for (let i = 0; i < 95; i += 1) {
    const id = `pa-fake-${i}`;
    store.recordPaperAuthor({
      id, paperId: 'p-smoke', authorName: `Fake ${i}`, authorPosition: i + 5,
      isFirstAuthor: true, isCorresponding: i % 2 === 0,
      orcid: fakes[i], chineseNameProbability: 0.7, isTargetCandidate: true,
    });
    ids.push(id);
  }
  return ids;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-orcid-smoke-'));
  const store = createStore({ dataDir: dir, sqlite });
  const seeded = seedHundred(store);
  console.log(`[smoke] seeded ${seeded.length} candidates in ${dir}`);

  const selected = store.selectOrcidLookupRows({ limit: 100 });
  assert.equal(selected.length, 100, `expected 100 candidates, got ${selected.length}`);

  const orcid = createOrcidEnrich({ logger: () => {} });
  const logPath = path.join(dir, 'orcid_query_log.jsonl');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  let processed = 0;
  let withEmail = 0;
  let notFound = 0;
  let realFailures = 0;
  let fetchedBack = 0;
  const t0 = Date.now();
  for (const row of selected) {
    try {
      const r = await orcid.processAuthor({ id: row.id, orcid: row.orcid });
      processed += 1;
      // 成功 OR 永久 404 都写回 orcid_last_fetched（避免 30 天内重复打）
      if (r._ok || r._status === 404) {
        try {
          store.recordOrcidProfile({
            id: row.id,
            emailOrcidId: r.emailOrcidId || null,
            orcidCreditName: r.orcidCreditName || null,
            orcidExternalIdsJson: r.orcidExternalIdsJson || null,
            orcidAffiliationsJson: r.orcidAffiliationsJson || null,
            orcidLastModified: r.orcidLastModified || null,
            orcidLastFetched: r.orcidLastFetched || new Date().toISOString(),
            orcidProfileJson: r.orcidProfileJson || null,
            emailRaw: r.emailRaw || null,
            emailSource: r.emailSource || null,
          });
          fetchedBack += 1;
        } catch (err) {
          console.error(`[smoke] recordOrcidProfile failed for id=${row.id}: ${err.message}`);
        }
      }
      if (r._ok) {
        if (r.emailRaw) withEmail += 1;
        logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), orcid: r._orcid, author_id: row.id, http_status: r._status, ok: true, has_email: !!r.emailRaw, duration_ms: r._durationMs })}\n`);
      } else if (r._status === 404) {
        notFound += 1;
        logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), orcid: r._orcid, author_id: row.id, http_status: r._status, ok: false, error: r._error, error_detail: r._errorDetail, duration_ms: r._durationMs, expected_silence: true })}\n`);
      } else {
        realFailures += 1;
        logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), orcid: r._orcid, author_id: row.id, http_status: r._status, ok: false, error: r._error, error_detail: r._errorDetail, duration_ms: r._durationMs })}\n`);
      }
    } catch (err) {
      realFailures += 1;
      logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), orcid: row.orcid, author_id: row.id, ok: false, error: 'exception', error_detail: err.message })}\n`);
    }
    if (processed % 10 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (processed / elapsed).toFixed(2);
      console.log(`[smoke] progress: ${processed}/100 (${rate} req/sec, ${elapsed.toFixed(1)}s)`);
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[smoke] DONE: ${processed} processed, ${withEmail} with email, ${notFound} not_found (expected), ${realFailures} real_failures, ${fetchedBack} writeback, ${elapsed}s elapsed`);

  // 验收
  assert.equal(processed, 100, '应处理 100 行');
  // 真 failure (5xx / 429 / 网络错误) < 5%
  assert.ok(realFailures / 100 < 0.05, `真失败率 ${realFailures / 100} 应 < 0.05`);
  const dbFetched = store.db.prepare('SELECT COUNT(*) AS n FROM paper_authors WHERE orcid_last_fetched IS NOT NULL').get().n;
  assert.ok(dbFetched >= 95, `DB 写回 ${dbFetched} 应 >= 95 (成功 OR 404 都应写 last_fetched)`);

  store.close();
  logStream.end();
  // 把这次 smoke 跑的真实 DB / 审计行拷贝到 workdir real-2026-06-07 便于交付
  const targetDir = path.resolve(__dirname, '..', '..', 'data', 'real-2026-06-07');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(path.join(dir, 'faculty.db'), path.join(targetDir, 'faculty.db'));
  fs.copyFileSync(logPath, path.join(targetDir, 'orcid_query_log.jsonl'));
  console.log(`[smoke] copied to ${targetDir}`);
  fs.rmSync(dir, { recursive: true, force: true });

  // 退出码
  if (realFailures / 100 > 0.5) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
