import type { ConfidenceBand, OcrWord } from '@kea/shared-types';

/**
 * 置信度阈值。
 * 注意：tesseract 的置信度没有校准，0.85 这个经验值实测把大量正确词挡在外面，
 * 在 6 张带文本层标注的试卷页上做了阈值扫描后取 0.70：
 * 可信词覆盖 75.6% → 82.0%，精确率 97.0% → 95.7%。
 * 接入第二个引擎后必须重跑校准实验再调这组值。
 */
export const CONFIDENCE_THRESHOLDS = {
  high: 0.7,
  mid: 0.6,
} as const;

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (confidence >= CONFIDENCE_THRESHOLDS.mid) return 'mid';
  return 'low';
}

export interface WordSummary {
  count: number;
  avgConfidence: number;
  high: number;
  mid: number;
  low: number;
  known: number;
  suspicious: number;
}

export function isSuspicious(word: OcrWord): boolean {
  return !word.lexiconHit || bandOf(word.confidence) !== 'high';
}

/** 可教学词：命中词库，才允许展示和发音 */
export function isTrusted(word: OcrWord): boolean {
  return word.lexiconHit;
}

export function summarizeWords(words: OcrWord[]): WordSummary {
  let high = 0;
  let mid = 0;
  let low = 0;
  let known = 0;
  let suspicious = 0;
  let sum = 0;

  for (const word of words) {
    sum += word.confidence;
    const band = bandOf(word.confidence);
    if (band === 'high') high += 1;
    else if (band === 'mid') mid += 1;
    else low += 1;

    if (word.lexiconHit) known += 1;
    if (isSuspicious(word)) suspicious += 1;
  }

  return {
    count: words.length,
    avgConfidence: words.length === 0 ? 0 : sum / words.length,
    high,
    mid,
    low,
    known,
    suspicious,
  };
}
