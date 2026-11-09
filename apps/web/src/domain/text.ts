/**
 * 英文 token 归一化与噪声过滤。
 * 真实拍照里最多的噪声是：中文被识别成拉丁字母、标点碎片、手写笔画。
 */
const LEADING_JUNK = /^[^A-Za-z]+/;
const TRAILING_JUNK = /[^A-Za-z'’-]+$/;
const ENGLISH_TOKEN = /^[A-Za-z][A-Za-z'’-]*$/;

export function normalizeEnglishToken(raw: string): string | null {
  const trimmed = raw.trim().replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '');

  if (trimmed.length === 0 || trimmed.length > 24) return null;
  if (!ENGLISH_TOKEN.test(trimmed)) return null;

  return trimmed;
}
