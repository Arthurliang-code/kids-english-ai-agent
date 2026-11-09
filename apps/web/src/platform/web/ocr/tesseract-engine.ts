import Tesseract from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import type { OcrLine, OcrResult, OcrWord, PixelBox, Quad } from '@kea/shared-types';
import type { OcrEngine, OcrEngineProgress, OcrInput, OcrEngineRun } from '../../core/types';
import { normalizeEnglishToken } from '../../../domain/text';

/**
 * 静态资源放在 public/tesseract，避免依赖 jsdelivr 等境外 CDN。
 * 引擎固定 LSTM。2026 年的 iPad Safari 会选 relaxed SIMD 这套内核，
 * 所以直接指向该文件，页面只下载这一套，不再带上其余变体。
 */
const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract`;
const CORE_FILE = `${ASSET_BASE}/tesseract-core-relaxedsimd-lstm.wasm.js`;

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

  async run(
    input: OcrInput,
    onProgress?: (p: OcrEngineProgress) => void,
  ): Promise<OcrEngineRun> {
    let initMs = 0;
    if (!this.worker) {
      const started = performance.now();
      await this.ensureWorker(onProgress);
      initMs = performance.now() - started;
    } else {
      await this.ensureWorker(onProgress);
    }

    const worker = this.worker;
    if (!worker) throw new Error('OCR 引擎初始化失败');

    const { width, height } = input.canvas;
    const started = performance.now();
    const { data } = await worker.recognize(input.canvas, {}, { text: true, blocks: true });
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
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
  }

  private ensureWorker(onProgress?: (p: OcrEngineProgress) => void): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: `${ASSET_BASE}/worker.min.js`,
        corePath: CORE_FILE,
        langPath: `${ASSET_BASE}/tessdata`,
        gzip: true,
        logger: (message) => {
          onProgress?.({
            status: message.status,
            progress: Math.max(0, Math.min(1, message.progress)),
          });
        },
      });

      await worker.setParameters({
        // 试卷/绘本照片是稀疏排版，稀疏模式明显优于默认自动分页
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });

      this.worker = worker;
    })();

    this.initPromise.catch(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }
}
