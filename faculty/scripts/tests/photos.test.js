// tests/photos.test.js — 单元测试：照片抽取 / 路径 / 状态

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PHOTO_STATUS,
  absolutizeUrl,
  inferExtension,
  isImageContentType,
  readMetaImages,
  parseImgTag,
  pickFromSrcset,
  extractPhotoCandidates,
  selectBestPhoto,
  inferPhotoStatus,
  photoRelPath,
  writePhoto,
} = require('../lib/photos.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- absolutizeUrl ---

test('absolutizeUrl: 相对 → 绝对', () => {
  const abs = absolutizeUrl('/img/x.jpg', 'https://x.edu/people/wang');
  assert.equal(abs, 'https://x.edu/img/x.jpg');
});

test('absolutizeUrl: data: 拒绝', () => {
  assert.equal(absolutizeUrl('data:image/png;base64,xxx', 'https://x'), null);
});

test('absolutizeUrl: javascript: 拒绝', () => {
  assert.equal(absolutizeUrl('javascript:void(0)', 'https://x'), null);
});

test('absolutizeUrl: 协议相对 → 继承 base', () => {
  const abs = absolutizeUrl('//cdn.x.com/p.jpg', 'https://x.edu/people');
  assert.equal(abs, 'https://cdn.x.com/p.jpg');
});

test('absolutizeUrl: 无 base 拒绝相对', () => {
  assert.equal(absolutizeUrl('img/x.jpg'), null);
});

test('absolutizeUrl: 已经是绝对 → 保留', () => {
  assert.equal(absolutizeUrl('https://a.b/c.jpg', 'https://x'), 'https://a.b/c.jpg');
});

// --- inferExtension ---

test('inferExtension: 优先 content-type', () => {
  assert.equal(inferExtension({ url: 'https://x/abc', contentType: 'image/jpeg' }), 'jpg');
  assert.equal(inferExtension({ url: 'https://x/abc', contentType: 'image/png' }), 'png');
  assert.equal(inferExtension({ url: 'https://x/abc', contentType: 'image/webp' }), 'webp');
});

test('inferExtension: 退到 URL 扩展名', () => {
  assert.equal(inferExtension({ url: 'https://x/y.JPG' }), 'jpg');
  assert.equal(inferExtension({ url: 'https://x/y.jpeg' }), 'jpg');
  assert.equal(inferExtension({ url: 'https://x/y.svg' }), 'svg');
});

test('inferExtension: 都没 → null', () => {
  assert.equal(inferExtension({ url: 'https://x/y' }), null);
  assert.equal(inferExtension({ url: 'https://x/y' }), null);
});

test('inferExtension: content-type 带 charset', () => {
  assert.equal(inferExtension({ url: 'https://x/y', contentType: 'image/jpeg; charset=utf-8' }), 'jpg');
});

// --- isImageContentType ---

test('isImageContentType: image/* 接受', () => {
  assert.equal(isImageContentType('image/jpeg'), true);
  assert.equal(isImageContentType('image/png; charset=binary'), true);
  assert.equal(isImageContentType('image/svg+xml'), true);
});

test('isImageContentType: text/html 拒绝', () => {
  assert.equal(isImageContentType('text/html'), false);
  assert.equal(isImageContentType('application/octet-stream'), false);
  assert.equal(isImageContentType(''), false);
  assert.equal(isImageContentType(null), false);
});

// --- readMetaImages ---

test('readMetaImages: og:image 命中', () => {
  const html = '<html><head><meta property="og:image" content="https://x/p.jpg"></head></html>';
  const m = readMetaImages(html);
  assert.equal(m.ogImage, 'https://x/p.jpg');
  assert.equal(m.twitterImage, null);
});

test('readMetaImages: twitter:image 命中 + content 在前顺序', () => {
  const html = '<html><head><meta content="https://x/tw.jpg" name="twitter:image"></head></html>';
  const m = readMetaImages(html);
  assert.equal(m.twitterImage, 'https://x/tw.jpg');
});

test('readMetaImages: og:image:secure_url 也算 og:image', () => {
  const html = '<html><head><meta property="og:image:secure_url" content="https://x/s.jpg"></head></html>';
  const m = readMetaImages(html);
  assert.equal(m.ogImage, 'https://x/s.jpg');
});

// --- parseImgTag ---

test('parseImgTag: 解析 src/alt/class/width/height', () => {
  const tag = '<img src="/p/x.jpg" alt="Wang headshot" class="headshot profile" width="200" height="200">';
  const a = parseImgTag(tag);
  assert.equal(a.src, '/p/x.jpg');
  assert.equal(a.alt, 'Wang headshot');
  assert.equal(a.class, 'headshot profile');
  assert.equal(a.width, '200');
  assert.equal(a.height, '200');
});

// --- pickFromSrcset ---

test('pickFromSrcset: 取最大 w 条目', () => {
  const src = 'small.jpg 200w, mid.jpg 400w, big.jpg 800w';
  assert.equal(pickFromSrcset(src), 'big.jpg');
});

test('pickFromSrcset: 1x 2x', () => {
  const src = 'a.jpg 1x, b.jpg 2x';
  assert.equal(pickFromSrcset(src), 'b.jpg');
});

test('pickFromSrcset: 空 → null', () => {
  assert.equal(pickFromSrcset(''), null);
  assert.equal(pickFromSrcset(null), null);
});

// --- extractPhotoCandidates ---

test('extractPhotoCandidates: og:image 排第一', () => {
  const html = '<html><head><meta property="og:image" content="https://x/og.jpg"></head><body><img class="headshot" src="/headshot.jpg"></body></html>';
  const base = 'https://x/people/wang';
  const cands = extractPhotoCandidates(html, base);
  assert.ok(cands.length >= 2);
  assert.equal(cands[0].url, 'https://x/og.jpg');
  assert.equal(cands[0].source, 'og:image');
  // img 候选解析成绝对 URL
  const hs = cands.find((c) => c.url === 'https://x/headshot.jpg');
  assert.ok(hs, 'headshot img 候选必须存在');
});

test('extractPhotoCandidates: class=headshot 命中', () => {
  const html = '<html><body><img class="headshot" src="/p.jpg" width="200" height="200"></body></html>';
  const cands = extractPhotoCandidates(html, 'https://x.edu/people');
  const img = cands.find((c) => c.source === 'img_tag');
  assert.ok(img);
  assert.ok(img.score >= 0.5, `score=${img.score}`);
});

test('extractPhotoCandidates: 含 logo/icon 的 img 排除（score<=0）', () => {
  const html = '<html><body><img src="/logo.png"><img class="headshot" src="/p.jpg" width="200" height="200"></body></html>';
  const cands = extractPhotoCandidates(html, 'https://x.edu/people');
  const logo = cands.find((c) => c.url === 'https://x.edu/logo.png');
  const head = cands.find((c) => c.url === 'https://x.edu/p.jpg');
  assert.equal(logo, undefined, 'logo 应被 score<=0 过滤掉');
  assert.ok(head, 'headshot 应保留');
  assert.ok(head.score > 0, `head.score=${head.score}`);
});

test('extractPhotoCandidates: 第一个 <img> 有 first_img 加分', () => {
  const html = '<html><body><img src="/p.jpg" width="200" height="200"></body></html>';
  const cands = extractPhotoCandidates(html, 'https://x.edu/people');
  const img = cands[0];
  assert.ok(img.reasons.includes('first_img'));
});

test('extractPhotoCandidates: <link rel=image_src> 命中', () => {
  const html = '<html><head><link rel="image_src" href="https://x/link.jpg"></head></html>';
  const cands = extractPhotoCandidates(html, 'https://x.edu/people');
  const found = cands.find((c) => c.url === 'https://x/link.jpg');
  assert.ok(found);
  assert.equal(found.source, 'link_image_src');
});

test('extractPhotoCandidates: 重复 URL 合并取最高分', () => {
  // 同一张图在 og:image 与 <img> 中重复时只保留一条
  const html = '<html><head><meta property="og:image" content="https://x.edu/p.jpg"></head><body><img src="https://x.edu/p.jpg"></body></html>';
  const cands = extractPhotoCandidates(html, 'https://x.edu/people');
  const same = cands.filter((c) => c.url === 'https://x.edu/p.jpg');
  assert.equal(same.length, 1);
  // og:image 应胜出（score=1.0）
  assert.equal(same[0].source, 'og:image');
});

// --- selectBestPhoto ---

test('selectBestPhoto: 空 → null', () => {
  assert.equal(selectBestPhoto([]), null);
  assert.equal(selectBestPhoto(null), null);
});

test('selectBestPhoto: 取 score 最高且 score>0', () => {
  const a = { url: 'https://x/a', score: 0.5 };
  const b = { url: 'https://x/b', score: 0.9 };
  const c = { url: 'https://x/c', score: -1 };
  assert.equal(selectBestPhoto([a, b, c]).url, 'https://x/b');
});

// --- inferPhotoStatus ---

test('inferPhotoStatus: ok + image/* + 合理大小 → success', () => {
  const s = inferPhotoStatus({ ok: true, status: 200, contentType: 'image/jpeg', bytes: 5000 });
  assert.equal(s, PHOTO_STATUS.SUCCESS);
});

test('inferPhotoStatus: 401/403 → anti_leech_suspected', () => {
  assert.equal(inferPhotoStatus({ ok: false, error: 'http_error', status: 401 }), PHOTO_STATUS.ANTI_LEECH);
  assert.equal(inferPhotoStatus({ ok: false, error: 'http_error', status: 403 }), PHOTO_STATUS.ANTI_LEECH);
});

test('inferPhotoStatus: 404 → http_error', () => {
  assert.equal(inferPhotoStatus({ ok: false, error: 'http_error', status: 404 }), PHOTO_STATUS.HTTP_ERROR);
});

test('inferPhotoStatus: timeout / dns_error / connection_refused', () => {
  assert.equal(inferPhotoStatus({ ok: false, error: 'timeout' }), PHOTO_STATUS.TIMEOUT);
  assert.equal(inferPhotoStatus({ ok: false, error: 'dns_error' }), PHOTO_STATUS.DNS_ERROR);
  assert.equal(inferPhotoStatus({ ok: false, error: 'connection_refused' }), PHOTO_STATUS.CONNECTION_REFUSED);
  assert.equal(inferPhotoStatus({ ok: false, error: 'too_large' }), PHOTO_STATUS.TOO_LARGE);
});

test('inferPhotoStatus: ok 但 content-type 不是 image → format_unsupported', () => {
  assert.equal(inferPhotoStatus({ ok: true, status: 200, contentType: 'text/html', bytes: 1000 }), PHOTO_STATUS.FORMAT_UNSUPPORTED);
});

test('inferPhotoStatus: ok + image + bytes<100 → anti_leech', () => {
  assert.equal(inferPhotoStatus({ ok: true, status: 200, contentType: 'image/png', bytes: 50 }), PHOTO_STATUS.ANTI_LEECH);
});

test('inferPhotoStatus: cross_host_redirect → manual_required', () => {
  assert.equal(inferPhotoStatus({ ok: false, error: 'cross_host_redirect' }), PHOTO_STATUS.MANUAL_REQUIRED);
});

// --- photoRelPath ---

test('photoRelPath: 标准格式', () => {
  const p = photoRelPath({
    schoolRank: 1, schoolName: 'MIT', departmentId: 'mit-sloan',
    sourceUrl: 'https://x/people/wang', photoUrl: 'https://x/photos/w.jpg',
    contentType: 'image/jpeg',
  });
  assert.match(p, /^html\/qs-01-mit\/mit-sloan\/people\/[a-f0-9]{12}\/photo\/[a-f0-9]{8}\.jpg$/);
});

test('photoRelPath: 同一 sourceUrl + 不同 photoUrl → 不同 photoKey', () => {
  const a = photoRelPath({
    schoolRank: 1, schoolName: 'MIT', departmentId: 'd',
    sourceUrl: 'https://x/p/w', photoUrl: 'https://x/a.jpg', contentType: 'image/jpeg',
  });
  const b = photoRelPath({
    schoolRank: 1, schoolName: 'MIT', departmentId: 'd',
    sourceUrl: 'https://x/p/w', photoUrl: 'https://x/b.jpg', contentType: 'image/jpeg',
  });
  assert.notEqual(a, b);
  // 但 person dir（12 字符）相同
  const aPerson = a.split('/').slice(0, 5).join('/');
  const bPerson = b.split('/').slice(0, 5).join('/');
  assert.equal(aPerson, bPerson);
});

test('photoRelPath: 不同 sourceUrl → 不同 person dir', () => {
  const a = photoRelPath({
    schoolRank: 1, schoolName: 'MIT', departmentId: 'd',
    sourceUrl: 'https://x/p/w1', photoUrl: 'https://x/a.jpg', contentType: 'image/jpeg',
  });
  const b = photoRelPath({
    schoolRank: 1, schoolName: 'MIT', departmentId: 'd',
    sourceUrl: 'https://x/p/w2', photoUrl: 'https://x/a.jpg', contentType: 'image/jpeg',
  });
  assert.notEqual(a, b);
});

// --- writePhoto ---

test('writePhoto: 落盘 + 读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faculty-photo-'));
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const r = writePhoto({
    fs,
    dataDir: dir,
    schoolRank: 1, schoolName: 'MIT', departmentId: 'd',
    sourceUrl: 'https://x/p/w', photoUrl: 'https://x/a.jpg',
    contentType: 'image/jpeg', body, ext: 'jpg',
  });
  assert.ok(fs.existsSync(r.absPath));
  const back = fs.readFileSync(r.absPath);
  assert.equal(back.length, 4);
  assert.equal(back[0], 0x89);
  fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { tests };
