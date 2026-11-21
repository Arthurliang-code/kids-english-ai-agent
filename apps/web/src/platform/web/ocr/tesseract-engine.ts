import Tesseract from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import type { OcrLine, OcrResult, OcrWord, PixelBox, Quad } from '@kea/shared-types';
import type { OcrEngine, OcrEngineProgress, OcrInput, OcrEngineRun } from '../../core/types';
import { normalizeEnglishToken, recoverPronounI } from '../../../domain/text';
import {
  checkOcrRuntimeSupport,
  normalizeWorkerError,
  selectCoreCandidates,
} from './ocr-startup';

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
const WORKER_SIMD_TIMEOUT_MS = 45_000;
const WORKER_FALLBACK_TIMEOUT_MS = 45_000;
const RECOGNIZE_TIMEOUT_MS = 30_000;

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
  private generation = 0;

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

            for (let wi = 0; wi < line.words.length; wi += 1) {
              const word = line.words[wi]!;
              const nextWord = line.words[wi + 1];
              let normalized = normalizeEnglishToken(word.text);
              let rawText = word.text.trim();

              if (!normalized && recoverPronounI(word.text, nextWord?.text)) {
                normalized = 'I';
                rawText = 'I';
              }

              if (!normalized) {
                if (word.text.trim().length > 0) filteredCount += 1;
                continue;
              }

              words.push({
                id: `${lineId}-w${indexInLine}`,
                text: normalized,
                rawText,
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
    this.generation += 1;
    this.progressListener = null;
    const worker = this.worker;
    this.worker = null;
    this.initPromise = null;
    await worker?.terminate();
  }

  private createWorkerForCore(
    coreFile: string,
    generation: number,
    timeoutMs: number,
  ): Promise<TesseractWorker> {
    let timedOut = false;
    this.progressListener?.({ status: 'loading tesseract core', progress: 0 });

    const createPromise = new Promise<TesseractWorker>((resolve, reject) => {
      try {
        void Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
          workerPath: `${ASSET_BASE}/worker.min.js`,
          corePath: coreFile,
          langPath: `${ASSET_BASE}/tessdata`,
          workerBlobURL: false,
          cacheMethod: 'none',
          gzip: true,
          logger: (message) => {
            if (timedOut || this.generation !== generation) return;
            this.progressListener?.({
              status: message.status,
              progress: Math.max(0, Math.min(1, message.progress)),
            });
          },
          errorHandler: (err) => {
            reject(normalizeWorkerError(err, coreFile));
          },
        }).then(
          (worker) => {
            if (timedOut || this.generation !== generation) {
              void worker.terminate();
              reject(new Error('OCR 引擎初始化已取消'));
              return;
            }
            resolve(worker);
          },
          (err) => {
            reject(normalizeWorkerError(err, coreFile));
          },
        );
      } catch (err) {
        reject(normalizeWorkerError(err, coreFile));
      }
    });

    return new Promise<TesseractWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('OCR 引擎下载或初始化超时'));
      }, timeoutMs);

      createPromise.then(
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

  private ensureWorker(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    const generation = this.generation;
    this.initPromise = (async () => {
      const support = checkOcrRuntimeSupport();
      if (!support.ok) {
        throw new Error(support.reason);
      }

      const candidates = selectCoreCandidates(ASSET_BASE);
      let lastError: unknown = null;

      for (let i = 0; i < candidates.length; i += 1) {
        const coreFile = candidates[i]!;
        if (this.generation !== generation) throw new Error('OCR 引擎已释放');
        const isLast = i === candidates.length - 1;
        const timeoutMs = isLast ? WORKER_FALLBACK_TIMEOUT_MS : WORKER_SIMD_TIMEOUT_MS;
        try {
          const worker = await this.createWorkerForCore(coreFile, generation, timeoutMs);
          if (this.generation !== generation) {
            void worker.terminate();
            throw new Error('OCR 引擎已释放');
          }
          await worker.setParameters({
            // 试卷/绘本照片是稀疏排版，稀疏模式明显优于默认自动分页
            tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
          });
          if (this.generation !== generation) {
            void worker.terminate();
            throw new Error('OCR 引擎已释放');
          }
          this.worker = worker;
          return;
        } catch (error) {
          lastError = error;
          // 若当前候选是因网络下载超时失败，不再立即并发启动第二个 3.9MB 核心下载抢带宽，直接交由用户重试
          if (error instanceof Error && error.message.includes('超时')) {
            break;
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error('OCR 引擎初始化失败');
    })();

    const currentInit = this.initPromise;
    currentInit.catch(() => {
      if (this.initPromise === currentInit) {
        this.initPromise = null;
      }
    });

    return currentInit;
  }
}
