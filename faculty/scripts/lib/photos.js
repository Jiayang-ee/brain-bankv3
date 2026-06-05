// photos.js — 教师照片下载（BRA-8）。
//
// 职责：
//   1. 从个人主页 HTML 抽取候选头像/照片 URL
//   2. 选择最可能的头像
//   3. 推断本地文件路径（不与同校/同名教师冲突）
//   4. 推断状态枚举（成功 / 无照片 / 访问失败 / 格式不支持 / 疑似防盗链 / 需人工处理）
//
// 本模块不发起网络请求、不写数据库，仅做纯函数处理 + 路径推断 + 状态判定。
// 调用方（scripts/photos.js）负责：读 HTML、调用 fetch.js、落盘、UPDATE candidates。

'use strict';

const { URL } = require('node:url');
const crypto = require('node:crypto');
const path = require('node:path');

const { schoolSlug, urlHash, ensureDir, relToPosix } = require('./files.js');

// 抓取状态枚举（与 crawl_log.status 对齐，新增 photo 维度）
const PHOTO_STATUS = Object.freeze({
  SUCCESS: 'success',
  NO_PHOTO: 'no_photo',
  HTTP_ERROR: 'http_error',
  TIMEOUT: 'timeout',
  DNS_ERROR: 'dns_error',
  CONNECTION_REFUSED: 'connection_refused',
  TOO_LARGE: 'too_large',
  FORMAT_UNSUPPORTED: 'format_unsupported',
  ANTI_LEECH: 'anti_leech_suspected',
  MANUAL_REQUIRED: 'manual_required',
  ERROR: 'error',
  SKIPPED: 'skipped', // 本地 HTML 缺失 / 候选人已 success 但本 run 跳过
});

// 允许的 image MIME → 文件扩展名
const IMAGE_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

// 路径扩展名 → 标准化
const URL_EXT_TO_STD = {
  jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  svg: 'svg',
  avif: 'avif',
  tif: 'tiff', tiff: 'tiff',
  ico: 'ico',
};

// 头像相关 class 关键词（出现即加分）
const HEADSHOT_CLASS_HINTS = [
  'headshot', 'portrait', 'avatar', 'profile-photo', 'profile-photo',
  'profile_photo', 'profile_pic', 'profilepic', 'user-photo', 'userphoto',
  'userpic', 'faculty-photo', 'faculty_photo', 'facultyphoto', 'person-photo',
  'hero-photo', 'staff-photo', 'staff_photo', 'staffphoto', 'bio-photo',
  'member-photo', 'people-photo', 'wp-image-', 'attachment-', 'wp-post-image',
];

// 头像相关 URL 路径子串
const HEADSHOT_URL_HINTS = [
  '/headshot', '/portrait', '/photo', '/avatar', '/profile',
  '/people/', '/faculty/', '/staff/', '/user/', '/users/',
  '/team/', '/member/', '/person/',
  '/sites/default/files/styles/photo',
];

// 把相对/绝对 URL 解析成绝对 URL；非 http(s) 返回 null
function absolutizeUrl(raw, base) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // data: / javascript: / mailto: / 协议相对的不接收
  if (/^(data|javascript|mailto|tel|about|blob):/i.test(s)) return null;
  // 已经是绝对
  if (/^https?:\/\//i.test(s)) return s;
  // 协议相对 → 继承 base
  if (s.startsWith('//')) {
    try { return new URL(s, base || 'https://_/').toString(); } catch (_) { return null; }
  }
  if (!base) return null;
  try { return new URL(s, base).toString(); } catch (_) { return null; }
}

// 推断扩展名：优先 content-type；再 URL 路径；最后 null
function inferExtension({ url, contentType }) {
  if (contentType) {
    const ct = String(contentType).toLowerCase().split(';')[0].trim();
    if (IMAGE_EXT[ct]) return IMAGE_EXT[ct];
  }
  if (url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (m) {
        const k = m[1].toLowerCase();
        if (URL_EXT_TO_STD[k]) return URL_EXT_TO_STD[k];
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

// 判断是否是 image/* 内容
function isImageContentType(ct) {
  if (!ct) return false;
  return /^image\//i.test(String(ct).split(';')[0].trim());
}

// 标准化 size hint: '100x100' / '100px' → 100
function parseSize(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*(?:px)?\s*(?:[xX×*]\s*(\d+)\s*(?:px)?)?/);
  if (!m) return null;
  return { w: Number(m[1]), h: m[2] ? Number(m[2]) : null };
}

// 解析 <img> 标签的属性；返回 { src, alt, class, width, height, srcset, sizes }
function parseImgTag(tagStr) {
  const out = {};
  for (const attr of ['src', 'alt', 'class', 'width', 'height', 'srcset', 'sizes', 'id', 'loading']) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
    const m = tagStr.match(re);
    if (m) out[attr] = decodeEntities(m[1]);
  }
  return out;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 抽取 <meta> 标签（与 extract.js 的 readMeta 类似，但只关心图片相关）
function readMetaImages(html) {
  const out = { ogImage: null, twitterImage: null };
  const re1 = /<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*?>/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (!v) continue;
    if (k === 'og:image' || k === 'og:image:url' || k === 'og:image:secure_url') {
      if (!out.ogImage) out.ogImage = v;
    } else if (k === 'twitter:image' || k === 'twitter:image:src') {
      if (!out.twitterImage) out.twitterImage = v;
    }
  }
  const re2 = /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["']([^"']+)["'][^>]*?>/gi;
  while ((m = re2.exec(html)) !== null) {
    const k = m[2].toLowerCase();
    const v = m[1].trim();
    if (!v) continue;
    if ((k === 'og:image' || k === 'og:image:url' || k === 'og:image:secure_url') && !out.ogImage) out.ogImage = v;
    else if ((k === 'twitter:image' || k === 'twitter:image:src') && !out.twitterImage) out.twitterImage = v;
  }
  return out;
}

// 从 srcset 取最大宽度条目
function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const scored = parts.map((p) => {
    const [url, ...rest] = p.split(/\s+/);
    const dw = rest.join(' ');
    let w = 0;
    const wm = dw.match(/(\d+)w/);
    const xm = dw.match(/([\d.]+)x/);
    if (wm) w = Number(wm[1]);
    else if (xm) w = Number(xm[1]) * 1000;
    return { url, w };
  });
  scored.sort((a, b) => b.w - a.w);
  return scored[0] ? scored[0].url : null;
}

// 给定一个 <img> 标签与所在 base url，返回 { url, source, score, reasons }
function scoreImgTag({ tagStr, baseUrl, htmlPosition }) {
  const attrs = parseImgTag(tagStr);
  if (!attrs.src && !attrs.srcset) return null;
  let rawUrl = attrs.src;
  if (!rawUrl && attrs.srcset) rawUrl = pickFromSrcset(attrs.srcset);
  if (!rawUrl) return null;
  const abs = absolutizeUrl(rawUrl, baseUrl);
  if (!abs) return null;
  const cls = (attrs.class || '').toLowerCase();
  const id = (attrs.id || '').toLowerCase();
  const alt = (attrs.alt || '').toLowerCase();
  const urlLc = abs.toLowerCase();

  let score = 0;
  const reasons = [];
  if (HEADSHOT_CLASS_HINTS.some((h) => cls.includes(h))) { score += 0.55; reasons.push(`class_hint:${cls.split(/\s+/).find((c) => HEADSHOT_CLASS_HINTS.some((h) => c.includes(h))) || 'match'}`); }
  if (HEADSHOT_CLASS_HINTS.some((h) => id.includes(h))) { score += 0.4; reasons.push('id_hint'); }
  if (HEADSHOT_URL_HINTS.some((h) => urlLc.includes(h))) { score += 0.4; reasons.push('url_hint'); }
  // alt 含 headshot/portrait/name words → 强信号
  if (alt && /(headshot|portrait|photo|profile|avatar)/.test(alt)) { score += 0.3; reasons.push('alt_photo'); }
  // 第一个 <img> 通常就是主图
  if (htmlPosition === 'first') { score += 0.15; reasons.push('first_img'); }
  // 尺寸：偏好合理头像大小 (>= 80 且 <= 800)
  const ws = parseSize(attrs.width);
  const hs = parseSize(attrs.height);
  const w = ws ? ws.w : null;
  const h = hs ? hs.h : null;
  if (w && w >= 80 && w <= 800) { score += 0.1; reasons.push(`width_in_range(${w})`); }
  // 排除明显非头像
  if (/\.(svg)(\?|$)/i.test(abs) && !/photo|portrait|avatar/.test(urlLc)) {
    // SVG 多数是 logo/icon
    score -= 0.2; reasons.push('svg_penalty');
  }
  if (/logo|sprite|banner|background|icon|spacer|placeholder/i.test(urlLc) && !/photo|portrait|avatar/.test(urlLc)) {
    score -= 0.6; reasons.push('logo_or_banner');
  }
  if (/gravatar\.com\/avatar\/?$|gravatar\.com\/avatar\/\?/.test(urlLc)) {
    score -= 0.5; reasons.push('default_gravatar');
  }
  if (score > 0.98) score = 0.98; // 永远 ≤ og:image 1.0 / twitter:image 0.99
  return { url: abs, source: 'img_tag', score, reasons, className: cls, alt: attrs.alt || null };
}

// 从 HTML 抽取候选照片 URL，返回降序的候选列表
function extractPhotoCandidates(html, baseUrl) {
  const out = [];
  if (!html) return out;

  // 1. og:image / twitter:image（最高优先级，绝对高于任何 <img> 启发式）
  const metas = readMetaImages(html);
  if (metas.ogImage) {
    const abs = absolutizeUrl(metas.ogImage, baseUrl);
    if (abs) out.push({ url: abs, source: 'og:image', score: 1.0, reasons: ['og_image'] });
  }
  if (metas.twitterImage) {
    const abs = absolutizeUrl(metas.twitterImage, baseUrl);
    if (abs) out.push({ url: abs, source: 'twitter:image', score: 0.99, reasons: ['twitter_image'] });
  }

  // 2. <img> 标签
  const imgRe = /<img\s+[^>]*?>/gi;
  let m;
  let imgIdx = 0;
  let firstImgPushed = false;
  while ((m = imgRe.exec(html)) !== null) {
    const tagStr = m[0];
    const position = imgIdx === 0 ? 'first' : 'other';
    imgIdx += 1;
    const cand = scoreImgTag({ tagStr, baseUrl, htmlPosition: position });
    if (!cand) continue;
    if (position === 'first' && !firstImgPushed) {
      firstImgPushed = true;
    }
    if (cand.score > 0) out.push(cand);
  }

  // 3. <link rel="image_src">
  const linkRe = /<link\s+[^>]*?rel=["']image_src["'][^>]*?href=["']([^"']+)["']/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const abs = absolutizeUrl(m[1], baseUrl);
    if (abs) out.push({ url: abs, source: 'link_image_src', score: 0.6, reasons: ['link_image_src'] });
  }
  // 反向顺序
  const linkRe2 = /<link\s+[^>]*?href=["']([^"']+)["'][^>]*?rel=["']image_src["']/gi;
  while ((m = linkRe2.exec(html)) !== null) {
    const abs = absolutizeUrl(m[1], baseUrl);
    if (abs) out.push({ url: abs, source: 'link_image_src', score: 0.6, reasons: ['link_image_src_reverse'] });
  }

  // 去重：同 URL 取最高分
  const byUrl = new Map();
  for (const c of out) {
    const prev = byUrl.get(c.url);
    if (!prev || c.score > prev.score) byUrl.set(c.url, c);
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

// 选最佳候选：score 最高且 score>0 且 URL 可解析；输入可为任意顺序
function selectBestPhoto(candidates) {
  if (!candidates || !candidates.length) return null;
  let best = null;
  for (const c of candidates) {
    if (!c || c.score <= 0) continue;
    try { new URL(c.url); } catch (_) { continue; }
    if (!best || c.score > best.score) best = c;
  }
  return best;
}

// 推断状态：给定下载结果 { ok, status, error, contentType, body, bytes }
function inferPhotoStatus({ ok, status, error, contentType, bytes }) {
  if (!ok) {
    // 优先按 fetch 阶段错误码归类
    if (error === 'timeout') return PHOTO_STATUS.TIMEOUT;
    if (error === 'dns_error') return PHOTO_STATUS.DNS_ERROR;
    if (error === 'connection_refused') return PHOTO_STATUS.CONNECTION_REFUSED;
    if (error === 'too_large') return PHOTO_STATUS.TOO_LARGE;
    if (error === 'http_error') {
      if (status === 401 || status === 403 || status === 451) return PHOTO_STATUS.ANTI_LEECH;
      return PHOTO_STATUS.HTTP_ERROR;
    }
    if (error === 'cross_host_redirect') return PHOTO_STATUS.MANUAL_REQUIRED;
    return PHOTO_STATUS.ERROR;
  }
  // ok=true 但还要校验 content-type 与大小
  if (!isImageContentType(contentType)) return PHOTO_STATUS.FORMAT_UNSUPPORTED;
  if (bytes === 0 || (typeof bytes === 'number' && bytes < 100)) return PHOTO_STATUS.ANTI_LEECH;
  return PHOTO_STATUS.SUCCESS;
}

// 照片本地路径（相对 faculty/data/）：
//   html/<school-slug>/<dept-id>/people/<person-sha1[0:12]>/photo/<photo-sha1[0:8]><.ext>
function photoRelPath({ schoolRank, schoolName, departmentId, sourceUrl, photoUrl, contentType, ext }) {
  const school = schoolSlug(schoolRank, schoolName);
  const personDir = urlHash(sourceUrl);
  // 用 source_url + photo_url 做 salt，避免同一个人不同 photo 撞名
  const photoKey = crypto.createHash('sha1').update(`${sourceUrl}|${photoUrl}`).digest('hex').slice(0, 8);
  const e = ext || inferExtension({ url: photoUrl, contentType }) || 'bin';
  return path.posix.join('html', school, departmentId, 'people', personDir, 'photo', `${photoKey}.${e}`);
}

// 写文件到本地归档；返回 { relPath, absPath }
function writePhoto({ fs, dataDir, schoolRank, schoolName, departmentId, sourceUrl, photoUrl, contentType, body, ext }) {
  const rel = photoRelPath({ schoolRank, schoolName, departmentId, sourceUrl, photoUrl, contentType, ext });
  const abs = path.join(dataDir, rel);
  ensureDir(fs, path.dirname(abs));
  fs.writeFileSync(abs, body);
  return { relPath: rel, absPath: abs };
}

// 把 photo 模块的相对路径转成跨平台 POSIX（保持一致性）
function photoRelToPosix(p) { return relToPosix(p); }

module.exports = {
  PHOTO_STATUS,
  IMAGE_EXT,
  HEADSHOT_CLASS_HINTS,
  HEADSHOT_URL_HINTS,
  absolutizeUrl,
  inferExtension,
  isImageContentType,
  readMetaImages,
  parseImgTag,
  scoreImgTag,
  pickFromSrcset,
  extractPhotoCandidates,
  selectBestPhoto,
  inferPhotoStatus,
  photoRelPath,
  writePhoto,
  photoRelToPosix,
};
