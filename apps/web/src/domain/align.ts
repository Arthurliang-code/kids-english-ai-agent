import type { AlignedWord, AlignSummary, OcrWord, VlmWord } from '@kea/shared-types';
import { CONFIDENCE_THRESHOLDS } from '../platform/core/classify';

/**
 * OCR 词框 与 VLM 词表 的对齐层。
 *
 * 实测结论（9 张真实照片）：VLM 的词表几乎全对，但它给出的 bbox 与 OCR 框的
 * 平均 IoU 只有 0.00–0.02，不能用来定位。所以这里的分工是：
 * - 文本以 VLM 为准（补漏词、纠正误识）
 * - 坐标一律沿用 OCR 的框
 * - 对不上的词进「仅词表」，不参与点读
 */

export interface AlignInput {
  ocrWords: OcrWord[];
  vlmWords: VlmWord[];
}

export interface AlignResult {
  words: AlignedWord[];
  summary: AlignSummary;
}

/** 允许的相对编辑距离上限；再大就不是同一个词的误识了 */
const MAX_DISTANCE_RATIO = 0.34;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** 编辑距离，超过上限直接返回上限 + 1，避免无谓计算 */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }

  return previous[b.length] ?? limit + 1;
}

/** 高置信且命中词库的词，认为不需要再纠正 */
function isTrustworthy(word: OcrWord): boolean {
  return word.lexiconHit && word.confidence >= CONFIDENCE_THRESHOLDS.high;
}

export function alignWords({ ocrWords, vlmWords }: AlignInput): AlignResult {
  const vlmByKey = new Map<string, VlmWord>();
  for (const word of vlmWords) {
    const key = normalize(word.text);
    if (key && !vlmByKey.has(key)) vlmByKey.set(key, word);
  }

  const entries: AlignedWord[] = [];
  const indexByKey = new Map<string, number>();
  const consumed = new Set<string>();

  const upsert = (key: string, word: OcrWord, text: string, status: AlignedWord['status'], vlm: VlmWord) => {
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      const entry = entries[existing];
      if (!entry) return;
      entry.count += 1;
      if (entry.ocrWordId === null) entry.ocrWordId = word.id;
      return;
    }
    entries.push({
      text,
      count: 1,
      ocrWordId: word.id,
      status,
      ocrText: status === 'corrected' ? word.text : null,
      teach: vlm.teach,
    });
    indexByKey.set(key, entries.length - 1);
  };

  // 一、精确匹配：文本一致，坐标直接复用
  for (const word of ocrWords) {
    const key = normalize(word.text);
    if (!key) continue;
    const vlm = vlmByKey.get(key);
    if (!vlm) continue;
    upsert(key, word, vlm.text, 'exact', vlm);
  }

  // 二、纠错匹配：只处理 OCR 认错的可疑词，一对一只消费一个候选
  for (const word of ocrWords) {
    const key = normalize(word.text);
    if (!key || indexByKey.has(key) || key.length < 3) continue;
    if (isTrustworthy(word)) continue;

    const limit = Math.max(1, Math.round(key.length * MAX_DISTANCE_RATIO));
    let bestKey: string | null = null;
    let bestDistance = limit + 1;

    for (const candidateKey of vlmByKey.keys()) {
      if (consumed.has(candidateKey) || indexByKey.has(candidateKey)) continue;
      if (candidateKey[0] !== key[0]) continue;
      const value = distance(key, candidateKey, limit);
      if (value < bestDistance) {
        bestDistance = value;
        bestKey = candidateKey;
      }
    }

    if (!bestKey || bestDistance > limit) continue;
    const vlm = vlmByKey.get(bestKey);
    if (!vlm) continue;

    consumed.add(bestKey);
    upsert(bestKey, word, vlm.text, 'corrected', vlm);
  }

  // 三、VLM 有、OCR 没定位到的词：进本页词表，但不参与点读
  for (const [key, vlm] of vlmByKey) {
    if (indexByKey.has(key)) continue;
    entries.push({
      text: vlm.text,
      count: 1,
      ocrWordId: null,
      status: 'vocabulary',
      ocrText: null,
      teach: vlm.teach,
    });
  }

  const located = entries.filter((entry) => entry.ocrWordId !== null).length;
  const corrected = entries.filter((entry) => entry.status === 'corrected').length;

  return {
    words: entries,
    summary: {
      located,
      corrected,
      vocabularyOnly: entries.length - located,
    },
  };
}
