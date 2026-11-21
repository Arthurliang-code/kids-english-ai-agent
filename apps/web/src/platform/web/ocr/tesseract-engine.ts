import Tesseract from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import type { OcrLine, OcrResult, OcrWord, PixelBox, Quad } from '@kea/shared-types';
import type { OcrEngine, OcrEngineProgress, OcrInput, OcrEngineRun } from '../../core/types';
import { normalizeEnglishToken, recoverPronounI } from '../../../domain/text';
import {
  checkOcrRuntimeSupport,
  dataUrlToUint8Array,
  gunzipBytes,
  normalizeWorkerError,
  selectCoreCandidates,
} from './ocr-startup';

interface DirectTessBaseApi {
  Init: (dataPath: string | null, lang: string, oem: number) => number;
  SetVariable: (key: string, value: string) => void;
  SetImageFile: (exif: number, angle: number) => number;
  Recognize: (monitor: null) => number;
  GetUTF8Text: () => string;
  GetJSONText: () => string;
  Version: () => string;
  End: () => void;
}

interface DirectTessModule {
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    unlink?: (path: string) => void;
  };
  TessBaseAPI: new () => DirectTessBaseApi;
}

type TesseractCoreFactory = (options?: {
  TesseractProgress?: (percent: number) => void;
}) => Promise<DirectTessModule>;

interface DirectCoreSession {
  tessModule: DirectTessModule;
  api: DirectTessBaseApi;
}

type RawRecognizeData = Awaited<ReturnType<TesseractWorker['recognize']>>['data'];

function loadCoreScriptOnMainThread(coreUrl: string, timeoutMs: number): Promise<TesseractCoreFactory> {
  const g = globalThis as { TesseractCore?: TesseractCoreFactory };
  if (typeof g.TesseractCore === 'function') {
    return Promise.resolve(g.TesseractCore);
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不支持主线程脚本加载'));
  }

  return new Promise<TesseractCoreFactory>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    script.src = coreUrl;
    script.async = true;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      script.remove();
      reject(new Error('OCR 内核脚本加载超时'));
    }, timeoutMs);

    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const factory = (globalThis as { TesseractCore?: TesseractCoreFactory }).TesseractCore;
      if (typeof factory === 'function') {
        resolve(factory);
      } else {
        reject(new Error('OCR 内核脚本未导出 TesseractCore'));
      }
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      reject(new Error('OCR 内核脚本加载失败'));
    };

    (document.head ?? document.documentElement).appendChild(script);
  });
}

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
  private directSession: DirectCoreSession | null = null;
  private pendingRawWorker: { terminate: () => void } | null = null;
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
      if (!this.worker && !this.directSession) {
        const started = performance.now();
        await this.ensureWorker();
        initMs = performance.now() - started;
      } else {
        await this.ensureWorker();
      }

      const worker = this.worker;
      const directSession = this.directSession;
      if (!worker && !directSession) throw new Error('OCR 引擎初始化失败');

      const { width, height } = input.canvas;
      const started = performance.now();
      let data: RawRecognizeData;
      try {
        if (worker) {
          const imagePayload = input.imageBytes ?? input.canvas;
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
        } else {
          data = this.recognizeWithDirectSession(directSession!, input);
        }
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
    const rawWorker = this.pendingRawWorker;
    this.pendingRawWorker = null;
    try {
      rawWorker?.terminate();
    } catch {
      // 忽略底层 Worker 终止异常
    }
    const direct = this.directSession;
    this.directSession = null;
    try {
      direct?.api.End();
    } catch {
      // 忽略主线程实例释放异常
    }
    const worker = this.worker;
    this.worker = null;
    this.initPromise = null;
    await worker?.terminate();
  }

  private recognizeWithDirectSession(
    session: DirectCoreSession,
    input: OcrInput,
  ): RawRecognizeData {
    const bytes =
      input.imageBytes ??
      (typeof input.canvas.toDataURL === 'function'
        ? dataUrlToUint8Array(input.canvas.toDataURL('image/jpeg', 0.88))
        : undefined);
    if (!bytes || bytes.byteLength === 0) {
      throw new Error('无法导出待识别照片数据');
    }

    this.progressListener?.({ status: 'recognizing text', progress: 0 });
    session.tessModule.FS.writeFile('/input', bytes);
    try {
      const setRes = session.api.SetImageFile(1, 0);
      if (setRes === 1) {
        throw new Error('OCR 引擎读取照片失败');
      }
      session.api.Recognize(null);
      const text = session.api.GetUTF8Text();
      const rawJson = session.api.GetJSONText();
      const parsed = JSON.parse(rawJson) as { blocks?: RawRecognizeData['blocks'] };
      const version = session.api.Version();
      this.progressListener?.({ status: 'recognizing text', progress: 1 });
      return {
        text,
        blocks: parsed.blocks ?? null,
        version,
      } as RawRecognizeData;
    } finally {
      try {
        session.tessModule.FS.unlink?.('/input');
      } catch {
        // 忽略临时文件清理异常
      }
    }
  }

  private async initDirectSession(generation: number, timeoutMs: number): Promise<DirectCoreSession> {
    const coreUrl = `${ASSET_BASE}/tesseract-core-lstm.wasm.js`;
    this.progressListener?.({ status: 'loading tesseract core', progress: 0 });
    const coreFactory = await loadCoreScriptOnMainThread(coreUrl, timeoutMs);
    if (this.generation !== generation) throw new Error('OCR 引擎已释放');

    this.progressListener?.({ status: 'initializing tesseract', progress: 0 });
    const tessModule = await withTimeout(
      coreFactory({
        TesseractProgress: (percent: number) => {
          if (this.generation !== generation) return;
          this.progressListener?.({
            status: 'recognizing text',
            progress: Math.max(0, Math.min(1, (percent - 30) / 70)),
          });
        },
      }),
      timeoutMs,
      'OCR 内核初始化超时',
    );
    if (this.generation !== generation) throw new Error('OCR 引擎已释放');

    this.progressListener?.({ status: 'loading language traineddata', progress: 0 });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const fetchTimer =
      controller && typeof setTimeout === 'function'
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    let rawTrainedData: Uint8Array;
    try {
      const resp = await fetch(`${ASSET_BASE}/tessdata/eng.traineddata.gz`, {
        signal: controller?.signal,
      });
      if (!resp.ok) {
        throw new Error(`词模下载失败 (${resp.status})`);
      }
      rawTrainedData = new Uint8Array(await resp.arrayBuffer());
    } finally {
      if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    }
    if (this.generation !== generation) throw new Error('OCR 引擎已释放');

    this.progressListener?.({ status: 'loading language traineddata', progress: 0.6 });
    const trainedData = await gunzipBytes(rawTrainedData, 10_000);
    if (this.generation !== generation) throw new Error('OCR 引擎已释放');

    tessModule.FS.writeFile('./eng.traineddata', trainedData);
    this.progressListener?.({ status: 'initializing api', progress: 0 });
    const api = new tessModule.TessBaseAPI();
    const status = api.Init(null, 'eng', 1);
    if (status === -1) {
      api.End();
      throw new Error('OCR 引擎词模初始化失败');
    }
    api.SetVariable('tessedit_pageseg_mode', String(Tesseract.PSM.SPARSE_TEXT));
    api.SetVariable('preserve_interword_spaces', '1');
    api.SetVariable('user_defined_dpi', '300');
    this.progressListener?.({ status: 'initializing api', progress: 1 });

    return { tessModule, api };
  }

  private createWorkerForCore(
    coreFile: string,
    generation: number,
    timeoutMs: number,
  ): Promise<TesseractWorker> {
    let timedOut = false;
    let rawWorker: { terminate: () => void } | null = null;
    const cleanupRawWorker = () => {
      if (rawWorker) {
        try {
          rawWorker.terminate();
        } catch {
          // 忽略底层 Worker 终止异常
        }
        if (this.pendingRawWorker === rawWorker) {
          this.pendingRawWorker = null;
        }
        rawWorker = null;
      }
    };

    this.progressListener?.({ status: 'loading tesseract core', progress: 0 });

    const createPromise = new Promise<TesseractWorker>((resolve, reject) => {
      const g = globalThis as { Worker?: typeof Worker };
      const OriginalWorker = typeof g.Worker === 'function' ? g.Worker : undefined;
      if (OriginalWorker) {
        const PatchedWorker = function (
          this: unknown,
          scriptURL: string | URL,
          options?: WorkerOptions,
        ) {
          const instance = new OriginalWorker(scriptURL, options);
          rawWorker = instance;
          return instance;
        } as unknown as typeof Worker;
        PatchedWorker.prototype = OriginalWorker.prototype;
        g.Worker = PatchedWorker;
      }

      let workerPromise: Promise<TesseractWorker>;
      try {
        workerPromise = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
          workerPath: `${ASSET_BASE}/worker.min.js?v=2`,
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
            cleanupRawWorker();
            reject(normalizeWorkerError(err, coreFile));
          },
        });
      } catch (err) {
        if (OriginalWorker) g.Worker = OriginalWorker;
        cleanupRawWorker();
        reject(normalizeWorkerError(err, coreFile));
        return;
      }
      if (OriginalWorker) {
        g.Worker = OriginalWorker;
      }
      this.pendingRawWorker = rawWorker;

      void workerPromise.then(
        (worker) => {
          if (this.pendingRawWorker === rawWorker) {
            this.pendingRawWorker = null;
          }
          if (timedOut || this.generation !== generation) {
            void worker.terminate();
            cleanupRawWorker();
            reject(new Error('OCR 引擎初始化已取消'));
            return;
          }
          resolve(worker);
        },
        (err) => {
          cleanupRawWorker();
          reject(normalizeWorkerError(err, coreFile));
        },
      );
    });

    return new Promise<TesseractWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        cleanupRawWorker();
        reject(new Error('OCR 引擎下载或初始化超时'));
      }, timeoutMs);

      createPromise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          cleanupRawWorker();
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
        }
      }

      // 若 iPad WebKit / 主屏幕 PWA 下 Web Worker 或 importScripts 均无法启动，自动回退到主线程直连 WASM 模式
      if (this.generation === generation) {
        try {
          const session = await this.initDirectSession(generation, WORKER_FALLBACK_TIMEOUT_MS);
          if (this.generation !== generation) {
            session.api.End();
            throw new Error('OCR 引擎已释放');
          }
          this.directSession = session;
          return;
        } catch (directError) {
          lastError = lastError ?? directError;
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
