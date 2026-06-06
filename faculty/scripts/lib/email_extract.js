// email_extract.js — 从 authorships 的 raw_affiliation_string 中提取邮箱（BRA-9.1 路径 A）。
//
// 数据源约束：
//   - OpenAlex: auth.raw_affiliation_string 形如
//     "Department of Surgical Oncology, Aster DM Healthcare, Bengaluru, Karnataka, India; Corresponding author: foo@bar.edu"
//     标 is_corresponding: true 时只给布尔位，不带邮箱
//   - Crossref: author.affiliation[].name 通常不含邮箱，路径 A 不期待 Crossref 出货
//
// 设计要点（PR #10 review 沉淀的边界）：
//   1. 邮箱用 RFC5322 简化正则 + 黑名单域 + 长度上限 + local/domain 形状校验
//   2. 同一作者多邮箱时按 "Corresponding author" 标记优先排序
//   3. email_source 枚举：openalex_regex / publisher_wiley / publisher_elsevier / orcid_public_api / manual
//      BRA-9.1 MVP 产 openalex_regex；BRA-9.2 spike 产 orcid_public_api（ORCID 公共 API 反向查询）；
//      publisher_* 留给后续 spike
//   4. 拒绝 ISSN-like 邮箱（"1234-5678@..."）、URL-like 邮箱（"http://x"）、纯数字 local part
//   5. email_match_context 截断到 500 字符，避免 context 字段过大
//
// 公开：
//   - EMAIL_SOURCE_OPENALEX_REGEX / EMAIL_SOURCE_PUBLISHER_WILEY / ..._ELSEVIER / ..._ORCID_PUBLIC_API / _MANUAL
//   - VALID_SOURCES
//   - REJECTED_DOMAINS
//   - EMAIL_RE
//   - isValidEmail(email)              → boolean
//   - extractEmailFromAffiliation(str) → { email, source, context, confidence } | null
//   - extractEmailForAuthor({ author }) → 同样返回结构

'use strict';

const EMAIL_SOURCE_OPENALEX_REGEX = 'openalex_regex';
const EMAIL_SOURCE_PUBLISHER_WILEY = 'publisher_wiley';
const EMAIL_SOURCE_PUBLISHER_ELSEVIER = 'publisher_elsevier';
const EMAIL_SOURCE_ORCID_PUBLIC_API = 'orcid_public_api';
const EMAIL_SOURCE_MANUAL = 'manual';
const VALID_SOURCES = [
  EMAIL_SOURCE_OPENALEX_REGEX,
  EMAIL_SOURCE_PUBLISHER_WILEY,
  EMAIL_SOURCE_PUBLISHER_ELSEVIER,
  EMAIL_SOURCE_ORCID_PUBLIC_API,
  EMAIL_SOURCE_MANUAL,
];

// 黑名单域：RFC 2606 保留域 + 通用 noreply 域
// 注释：example.com / test.com / localhost 是 RFC 2606 保留域，junk 数据源常滥用
const REJECTED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu',
  'test.com', 'test.org', 'test.edu',
  'noreply.com', 'no-reply.com', 'noreply.org', 'noreply.edu',
  'localhost', 'localhost.localdomain',
  // 以下保留为占位黑名单（OpenAlex 历史上出现过）：
  'email.com', 'yourcompany.com', 'yourdomain.com',
]);

// RFC5322 简化版：local@domain.tld
//   - local: A-Za-z0-9._%+-
//   - domain: A-Za-z0-9.- （含子域）
//   - tld: 2-24 个纯字母
// 注意：\b 词边界在 @ 附近 OK；中英标点附近不冲突
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;

// local-part 不应是 ISSN-like 数字
const ISSN_LIKE_LOCAL_RE = /^\d{4}-?\d{3}[\dXx]?@/;
// local-part 不应是纯数字
const PURE_DIGIT_LOCAL_RE = /^\d+$/;
// domain 不应是 URL 协议 / 数字 IP
const URL_PREFIX_RE = /^(https?|ftp|www|doi|orcid|arxiv|file):/i;
const IP_DOMAIN_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// "Corresponding author" / "correspondance" / "to whom correspondence" 标记
const CORRESPONDING_MARKER_RE = /corresponding\s*author|correspondance|to\s*whom\s*correspondence|for\s*correspondence/i;

const MAX_EMAIL_LEN = 254;       // RFC 5321
const MAX_LOCAL_LEN = 64;         // RFC 5321
const MAX_CONTEXT_LEN = 500;
const HIGH_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.6;

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length > MAX_EMAIL_LEN) return false;
  if (ISSN_LIKE_LOCAL_RE.test(e)) return false;
  const atIdx = e.indexOf('@');
  if (atIdx < 1) return false;
  const local = e.slice(0, atIdx);
  const domain = e.slice(atIdx + 1).toLowerCase();
  if (local.length > MAX_LOCAL_LEN) return false;
  if (PURE_DIGIT_LOCAL_RE.test(local)) return false;
  if (URL_PREFIX_RE.test(domain)) return false;
  if (IP_DOMAIN_RE.test(domain)) return false;
  if (REJECTED_DOMAINS.has(domain)) return false;
  if (!domain.includes('.')) return false;
  const tld = domain.split('.').pop();
  if (!/^[a-z]{2,24}$/i.test(tld)) return false;
  return true;
}

// 从一段 affiliation 文本里抽邮箱。返回 { email, source, context, confidence } 或 null。
// 命中规则：
//   1. 用 EMAIL_RE 找全部 candidate
//   2. 取第一个 isValidEmail() 为 true 的
//   3. confidence: 含 "Corresponding author" 标记 → 0.9；否则 0.6
function extractEmailFromAffiliation(affiliationString) {
  if (!affiliationString || typeof affiliationString !== 'string') return null;
  // 重置 lastIndex (模块级 regex 用 /g 标志)
  EMAIL_RE.lastIndex = 0;
  const matches = affiliationString.match(EMAIL_RE) || [];
  if (matches.length === 0) return null;
  for (const raw of matches) {
    if (!isValidEmail(raw)) continue;
    const hasMarker = CORRESPONDING_MARKER_RE.test(affiliationString);
    return {
      email: raw,
      source: EMAIL_SOURCE_OPENALEX_REGEX,
      context: affiliationString.slice(0, MAX_CONTEXT_LEN),
      confidence: hasMarker ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    };
  }
  return null;
}

// 把一行的 affiliation_raw 按 ; 或 ； 切成多段，优先从含 "Corresponding author" 标记的段抽
function extractEmailForAuthor({ author }) {
  if (!author) return null;
  const affRaw = author.affiliation_raw || author.raw_affiliation_string || null;
  if (!affRaw) return null;
  // 切分（中文 ; 也兼容）
  const parts = affRaw.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // 优先从 "Corresponding author" 段抽；无标记则按原顺序
  const sorted = parts.slice().sort((a, b) => {
    const aHas = CORRESPONDING_MARKER_RE.test(a) ? 1 : 0;
    const bHas = CORRESPONDING_MARKER_RE.test(b) ? 1 : 0;
    return bHas - aHas;
  });
  for (const part of sorted) {
    const r = extractEmailFromAffiliation(part);
    if (r) return r;
  }
  return null;
}

module.exports = {
  EMAIL_SOURCE_OPENALEX_REGEX,
  EMAIL_SOURCE_PUBLISHER_WILEY,
  EMAIL_SOURCE_PUBLISHER_ELSEVIER,
  EMAIL_SOURCE_ORCID_PUBLIC_API,
  EMAIL_SOURCE_MANUAL,
  VALID_SOURCES,
  REJECTED_DOMAINS: [...REJECTED_DOMAINS],
  EMAIL_RE,
  CORRESPONDING_MARKER_RE,
  MAX_EMAIL_LEN,
  MAX_LOCAL_LEN,
  MAX_CONTEXT_LEN,
  isValidEmail,
  extractEmailFromAffiliation,
  extractEmailForAuthor,
};
