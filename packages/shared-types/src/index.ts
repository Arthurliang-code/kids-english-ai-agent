/**
 * 跨端共享的 OCR 数据结构。
 * 坐标约定：quad 一律归一化到 0–1（左上角为原点），与图片分辨率解耦。
 */

export interface Point {
  x: number;
  y: number;
}

/** 顺序固定为：左上、右上、右下、左下 */
export type Quad = [Point, Point, Point, Point];

export type OcrEngineId = 'tesseract' | 'paddle' | 'vision' | 'cloud';

export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  /** 页内唯一，格式 `l{行号}-w{行内序号}` */
  id: string;
  /** 原始识别文本，未做纠错 */
  text: string;
  /** 归一化置信度 0–1（引擎原始值，尚未做校准映射） */
  confidence: number;
  quad: Quad;
  lineId: string;
  indexInLine: number;
  /** 是否命中英文词库，由上层在识别后标注 */
  lexiconHit: boolean;
  /** 仅调试用，坐标为识别输入图的像素值 */
  bbox: PixelBox;
}

export interface OcrLine {
  id: string;
  text: string;
  confidence: number;
  quad: Quad;
}

export interface OcrResult {
  engine: OcrEngineId;
  engineVersion: string;
  words: OcrWord[];
  lines: OcrLine[];
  rawText: string;
  image: { width: number; height: number };
  /** 被非英文/噪声规则丢弃的 token 数 */
  filteredCount: number;
}

export interface OcrMetrics {
  /** 引擎首次初始化耗时（模型加载），命中缓存后为 0 */
  initMs: number;
  preprocessMs: number;
  recognizeMs: number;
  totalMs: number;
  imageWidth: number;
  imageHeight: number;
  wordCount: number;
  avgConfidence: number;
  high: number;
  mid: number;
  low: number;
  /** 命中词库的词数 */
  known: number;
  /** 词库外或置信不足的词数 */
  suspicious: number;
  /** 被噪声规则丢弃的 token 数（中文、符号、手写碎片） */
  filteredCount: number;
}

export type ConfidenceBand = 'high' | 'mid' | 'low';

/* ---------- 云端语义复核（VLM） ---------- */

export interface VlmWord {
  text: string;
  /** 是否适合作为小学词汇教学（人名、选项字母等为 false） */
  teach: boolean;
}

export interface VlmUncertain {
  guess: string;
  reason: string;
}

export interface VlmReview {
  model: string;
  /** 模型对页面年级/难度的判断 */
  level: string | null;
  words: VlmWord[];
  uncertain: VlmUncertain[];
  latencyMs: number;
  totalTokens: number | null;
}

/* ---------- OCR 与 VLM 词表的对齐结果 ---------- */

/**
 * - exact：OCR 原文与 VLM 词一致，坐标可用
 * - corrected：OCR 认错、由 VLM 纠正，坐标沿用 OCR 的框
 * - vocabulary：只在 VLM 词表里出现，OCR 没有对应词，无坐标
 */
export type AlignStatus = 'exact' | 'corrected' | 'vocabulary';

export interface AlignedWord {
  /** 采纳后的文本 */
  text: string;
  /** 词在页面上出现的次数 */
  count: number;
  /** 有值才能点读高亮 */
  ocrWordId: string | null;
  status: AlignStatus;
  /** 被纠正时保留 OCR 原文，便于人工核对 */
  ocrText: string | null;
  teach: boolean;
}

export interface AlignSummary {
  /** 定位到的词（exact + corrected） */
  located: number;
  corrected: number;
  /** 只有词表、没有坐标的词 */
  vocabularyOnly: number;
}
