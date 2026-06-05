// Build snapshot.manifest.json for BRA-7.2 HTML archive.
// Walks html/, computes sha256 + size for each *.html, and emits a JSON manifest.

import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const SNAP_DIR = 'faculty/data-snapshots/bra-7.2-2026-06-03';
const HTML_DIR = join(SNAP_DIR, 'html');
const OUT = join(SNAP_DIR, 'snapshot.manifest.json');

const ASSET = {
  name: 'faculty-data-snapshot-2026-06-03-html.tar.gz',
  url: 'https://github.com/Jiayang-ee/brain-bankv3/releases/download/v0.1.0-faculty-snap-2026-06-03/faculty-data-snapshot-2026-06-03-html.tar.gz',
  size: 34563394,
  sha256: 'df3ed1a6c440bc5bc7bf15040d9b88eab6638800245a2cc56e10c6a220697a6f',
  release_tag: 'v0.1.0-faculty-snap-2026-06-03',
  release_url: 'https://github.com/Jiayang-ee/brain-bankv3/releases/tag/v0.1.0-faculty-snap-2026-06-03',
};

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const t0 = Date.now();
const files = [];
let totalBytes = 0;
for await (const p of walk(HTML_DIR)) {
  if (!p.endsWith('.html')) continue;
  const buf = await readFile(p);
  const rel = relative(SNAP_DIR, p);
  files.push({ path: rel, size: buf.length, sha256: sha256(buf) });
  totalBytes += buf.length;
}
files.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  snapshot: {
    id: 'bra-7.2-2026-06-03',
    issue: 'BRA-7.2',
    issue_url: 'https://github.com/Jiayang-ee/brain-bankv3/issues/13',
    pr_url: 'https://github.com/Jiayang-ee/brain-bankv3/pull/6',
    captured_at: {
      start: '2026-06-03T17:17:00Z',
      end: '2026-06-03T19:38:00Z',
      duration_seconds: 8483,
    },
    command: 'node faculty/scripts/discover.js --all --out ./faculty/data',
    validate_status: 'VALIDATION OK',
    school_coverage: '50/50',
  },
  files_inline: {
    faculty_db: 'faculty.db',
    candidates_jsonl: 'candidates.jsonl',
    crawl_log_jsonl: 'crawl_log.jsonl',
  },
  html_archive: {
    format: 'tar.gz',
    extract_command: `tar -xzf ${ASSET.name} -C ${SNAP_DIR}/`,
    ...ASSET,
    file_count: files.length,
    total_uncompressed_bytes: totalBytes,
    files,
  },
  schema_version: 1,
  generated_at: new Date().toISOString(),
  generator: 'faculty/data-snapshots/bra-7.2-2026-06-03/build-manifest.mjs',
};

await writeFile(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${OUT}`);
console.log(`  files: ${files.length}`);
console.log(`  total uncompressed: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
