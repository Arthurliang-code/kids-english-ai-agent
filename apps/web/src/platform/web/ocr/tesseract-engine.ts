import Tesseract from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import type { OcrLine, OcrResult, OcrWord, PixelBox, Quad } from '@kea/shared-types';
import type { OcrEngine, OcrEngineProgress, OcrInput, OcrEngineRun } from '../../core/types';
import { normalizeEnglishToken } from '../../../domain/text';

/**
 * 静态资源放在 public/tesseract，避免依赖 jsdelivr 等境外 CDN。
 *
 * 兼容与稳定性设计（尤其针对 iPad Safari / WebKit）：
 * 1. iPadOS < 18.2 的 WebKit 不支持 WebAssembly Relaxed SIMD，硬编码 relaxedsimd
 *    会导致 WebAssembly.CompileError，且 tesseract.js 内部 createWorker.js 末尾
 *    `.catch(() => {})` 会吞掉异常，导致 Promise 永远挂起、界面一直停在“正在认字…”。
 *    因此按运行时能力探测并按候选链自动降级：
 *    - 桌面端优先 relaxedsimd -> simd -> 基础 lstm
 *    - iPadOS / iOS 端优先标准 128-bit simd -> 基础 lstm
 * 2. 设 `workerBlobURL: false` 直接加载同源 `/tesseract/worker.min.js`，避开 iPad PWA
 *    下 `blob:` Worker 拦截与相对路径问题。
 * 3. 设 `cacheMethod: 'none'` 禁用 Worker 内 `idb-keyval` IndexedDB 读写，交由
 *    Service Worker Cache Storage 持久缓存 `eng.traineddata.gz`，避免 iPad WebKit
 *    Worker 内 IndexedDB 锁死或读出旧版不兼容缓存。
 */
const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract`;
const WORKER_INIT_TIMEOUT_MS = 20_000;
const RECOGNIZE_TIMEOUT_MS = 30_000;

/** wasm-feature-detect 标准探测字节码 */
const RELAXED_SIMD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253,
  15, 65, 2, 253, 15, 253, 128, 2, 11,
]);
const SIMD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function getCoreCandidates(): string[] {
  const candidates: string[] = [];
  const canValidate =
    typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';

  if (canValidate && !isAppleTouchDevice() && WebAssembly.validate(RELAXED_SIMD_WASM)) {
    candidates.push(`${ASSET_BASE}/tesseract-core-relaxedsimd-lstm.wasm.js`);
  }
  if (canValidate && WebAssembly.validate(SIMD_WASM)) {
    candidates.push(`${ASSET_BASE}/tesseract-core-simd-lstm.wasm.js`);
  }
  candidates.push(`${ASSET_BASE}/tesseract-core-lstm.wasm.js`);
  return candidates;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rectToQuad(box: PixelBox, width: number, height: number): Quad {
  const x0 = box.x0 / width;
  const y0 = box.y0 / height;
  const x1 = box.x1 / width;
  const y1 = box.y1 / height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract' as const;
  readonly label = 'Tesseract.js 7 · WASM';

  private worker: TesseractWorker | null = null;
  private initPromise: Promise<void> | null = null;
  private progressListener: ((p: OcrEngineProgress) => void) | null = null;

  warm(): Promise<void> {
    return this.ensureWorker().catch(() => undefined);
  }

  async run(
    input: OcrInput,
    onProgress?: (p: OcrEngineProgress) => void,
  ): Promise<OcrEngineRun> {
    this.progressListener = onProgress ?? null;
    try {
      let initMs = 0;
      if (!this.worker) {
        const started = performance.now();
        await this.ensureWorker();
        initMs = performance.now() - started;
      } else {
        await this.ensureWorker();
      }

      const worker = this.worker;
      if (!worker) throw new Error('OCR 引擎初始化失败');

      const { width, height } = input.canvas;
      const started = performance.now();
      const imagePayload = input.imageBytes ?? input.canvas;
      let data: Awaited<ReturnType<TesseractWorker['recognize']>>['data'];
      try {
        const response = await withTimeout(
          worker.recognize(
            imagePayload as unknown as HTMLCanvasElement,
            {},
            { text: true, blocks: true },
          ),
          RECOGNIZE_TIMEOUT_MS,
          'OCR 识别超时',
        );
        data = response.data;
      } catch (error) {
        await this.dispose();
        throw error;
      }
      const recognizeMs = performance.now() - started;

      const words: OcrWord[] = [];
      const lines: OcrLine[] = [];
      let filteredCount = 0;

      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const lineId = `l${lines.length}`;
            let indexInLine = 0;

            lines.push({
              id: lineId,
              text: line.text,
              confidence: line.confidence / 100,
              quad: rectToQuad(line.bbox, width, height),
            });

            for (const word of line.words) {
              const normalized = normalizeEnglishToken(word.text);
              if (!normalized) {
                if (word.text.trim().length > 0) filteredCount += 1;
                continue;
              }

              words.push({
                id: `${lineId}-w${indexInLine}`,
                text: normalized,
                confidence: Math.max(0, Math.min(1, word.confidence / 100)),
                quad: rectToQuad(word.bbox, width, height),
                lineId,
                indexInLine,
                lexiconHit: false,
                bbox: word.bbox,
              });
              indexInLine += 1;
            }
          }
        }
      }

      const result: OcrResult = {
        engine: this.id,
        engineVersion: data.version,
        words,
        lines,
        rawText: data.text,
        image: { width, height },
        filteredCount,
      };

      return { result, recognizeMs, initMs };
    } finally {
      if (this.progressListener === onProgress) {
        this.progressListener = null;
      }
    }
  }

  async dispose(): Promise<void> {
    this.progressListener = null;
    await this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
  }

  private createWorkerForCore(coreFile: string): Promise<TesseractWorker> {
    const createPromise = new Promise<TesseractWorker>((resolve, reject) => {
      void Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: `${ASSET_BASE}/worker.min.js`,
        corePath: coreFile,
        langPath: `${ASSET_BASE}/tessdata`,
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (message) => {
          this.progressListener?.({
            status: message.status,
            progress: Math.max(0, Math.min(1, message.progress)),
          });
        },
        errorHandler: (err) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      }).then(resolve, reject);
    });

    return withTimeout(createPromise, WORKER_INIT_TIMEOUT_MS, 'OCR 引擎初始化超时');
  }

  private ensureWorker(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const candidates = getCoreCandidates();
      let lastError: unknown = null;

      for (const coreFile of candidates) {
        try {
          const worker = await this.createWorkerForCore(coreFile);
          await worker.setParameters({
            // 试卷/绘本照片是稀疏排版，稀疏模式明显优于默认自动分页
            tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
          });
          this.worker = worker;
          return;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('OCR 引擎初始化失败');
    })();

    this.initPromise.catch(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }
}
