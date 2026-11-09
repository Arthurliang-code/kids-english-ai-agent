import type { OcrEngineId, OcrResult } from '@kea/shared-types';

export interface OcrEngineProgress {
  status: string;
  /** 0–1 */
  progress: number;
}

export interface OcrInput {
  /** 已完成预处理的识别输入图 */
  canvas: HTMLCanvasElement;
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
  run(input: OcrInput, onProgress?: (p: OcrEngineProgress) => void): Promise<OcrEngineRun>;
  dispose(): Promise<void>;
}
