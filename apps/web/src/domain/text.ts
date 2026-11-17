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

const FIRST_PERSON_FOLLOWERS =
  /^(am|have|has|had|like|likes|love|want|need|can|could|will|would|shall|should|may|might|must|do|did|don't|didn't|was|were|went|saw|bought|cleaned|ate|read|play|played|go|come|came|get|got|know|think|feel|hope|wish|always|often|usually|never|'m|'ve|'ll|'d)$/i;

/**
 * Tesseract 常把英文句首或逗号后的大写 "I" 误识为竖线 "|" / "｜"。
 * 在有明确第一人称语境（后接常见动词/助动词）时恢复为 "I"。
 */
export function recoverPronounI(raw: string, nextRaw?: string): boolean {
  const cleaned = raw.trim().replace(/^[,.;:!?'"“”‘’]+|[,.;:!?'"“”‘’]+$/g, '');
  if (cleaned !== '|' && cleaned !== '｜') return false;
  if (!nextRaw) return false;
  const nextClean = normalizeEnglishToken(nextRaw);
  if (!nextClean) return false;
  return FIRST_PERSON_FOLLOWERS.test(nextClean);
}
