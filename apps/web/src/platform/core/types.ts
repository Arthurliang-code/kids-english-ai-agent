import type { OcrEngineId, OcrResult } from '@kea/shared-types';

export interface OcrEngineProgress {
  status: string;
  /** 0–1 */
  progress: number;
}

export interface OcrInput {
  /** 已完成预处理的识别输入图 */
  canvas: HTMLCanvasElement;
  /** 已编码的轻量 JPEG 字节流，直传 Worker 避免触发默认的无损 PNG 压缩 */
  imageBytes?: Uint8Array;
}

export interface OcrEngineRun {
  result: OcrResult;
  /** 本次识别耗时（不含初始化） */
  recognizeMs: number;
  /** 引擎初始化耗时，已初始化过则为 0 */
  initMs: number;
}

export interface OcrEngine {
  readonly id: OcrEngineId;
  readonly label: string;
  warm?(): Promise<void>;
  run(input: OcrInput, onProgress?: (p: OcrEngineProgress) => void): Promise<OcrEngineRun>;
  dispose(): Promise<void>;
}
