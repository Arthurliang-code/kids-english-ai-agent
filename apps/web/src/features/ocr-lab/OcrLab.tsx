import { useCallback, useEffect, useRef, useState } from 'react';
import type { OcrMetrics, OcrResult, OcrWord, VlmReview } from '@kea/shared-types';
import type { OcrEngine, OcrEngineProgress } from '../../platform/core/types';
import { isTrusted, summarizeWords } from '../../platform/core/classify';
import { loadLexicon, lookupWord } from '../../domain/lexicon';
import { alignWords, type AlignResult } from '../../domain/align';
import { TesseractEngine } from '../../platform/web/ocr/tesseract-engine';
import { loadImage, preprocess, toJpegDataUrl } from '../../platform/web/ocr/preprocess';
import { reviewPage, REVIEW_MAX_EDGE } from '../../platform/web/vlm/client';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import { speakEnglish } from '../../speech/speak';
import { ReviewPanel } from '../review/ReviewPanel';
import { CameraSheet } from './CameraSheet';
import { ImageStage, type WordFilter } from './ImageStage';
import { SidePanel } from './SidePanel';

type RunStatus = 'idle' | 'running' | 'done' | 'error';

interface Source {
  url: string;
  width: number;
  height: number;
  name: string;
  fromObjectUrl: boolean;
}

const MAX_EDGE_OPTIONS = [1600, 2048, 2560] as const;

/** 中文进度文案，避免直接暴露 tesseract 的英文状态 */
const STATUS_TEXT: Record<string, string> = {
  'loading tesseract core': '加载 WASM 内核',
  'initializing tesseract': '初始化引擎',
  'loading language traineddata': '加载英文模型',
  'initializing api': '准备识别接口',
  'recognizing text': '识别文字',
};

export function OcrLab({ onApplyUpdate }: { onApplyUpdate: (() => void) | null }) {
  const [source, setSource] = useState<Source | null>(null);
  const [maxEdge, setMaxEdge] = useState<number>(2048);
  const [grayscale, setGrayscale] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [progress, setProgress] = useState<OcrEngineProgress | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [metrics, setMetrics] = useState<OcrMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 默认只看可教学词：词库外词不展示、不发音，避免把识别噪声当单词教给孩子
  const [filter, setFilter] = useState<WordFilter>('trusted');
  const [lexiconReady, setLexiconReady] = useState<boolean | null>(null);
  const reviewAvailable = import.meta.env.DEV || Boolean(import.meta.env.VITE_VLM_ENDPOINT);
  const [reviewEnabled, setReviewEnabled] = useState(import.meta.env.DEV);
  const [view, setView] = useState<'read' | 'review'>('read');
  const [review, setReview] = useState<VlmReview | null>(null);
  const [alignment, setAlignment] = useState<AlignResult | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);

  const engineRef = useRef<OcrEngine | null>(null);

  useEffect(() => {
    return () => {
      void engineRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (source?.fromObjectUrl) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  const applyImage = useCallback(async (url: string, name: string, fromObjectUrl: boolean) => {
    const image = await loadImage(url);
    setSource({ url, width: image.naturalWidth, height: image.naturalHeight, name, fromObjectUrl });
    setResult(null);
    setMetrics(null);
    setSelectedId(null);
    setStatus('idle');
    setError(null);
    setReview(null);
    setAlignment(null);
    setReviewNote(null);
  }, []);

  const handleFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    await applyImage(url, file.name, true);
  };

  const handleCapture = async (dataUrl: string) => {
    const name = `camera-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}`;
    await applyImage(dataUrl, name, false);
    setCameraOpen(false);
  };

  const runOcr = async () => {
    if (!source || status === 'running') return;

    setStatus('running');
    setError(null);
    setResult(null);
    setMetrics(null);
    setSelectedId(null);
    setReview(null);
    setAlignment(null);
    setReviewNote(null);
    setProgress({ status: '准备识别', progress: 0 });

    const totalStarted = performance.now();

    try {
      const image = await loadImage(source.url);

      // 云端复核与端侧识别并行，互不阻塞；失败也不影响本地结果
      const reviewTask = reviewEnabled
        ? reviewPage(toJpegDataUrl(image, REVIEW_MAX_EDGE)).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : null;

      const pre = await preprocess(image, { maxEdge, grayscale });

      const engine = (engineRef.current ??= new TesseractEngine());
      const run = await engine.run({ canvas: pre.canvas }, (next) => setProgress(next));

      const lexicon = await loadLexicon();
      setLexiconReady(lexicon !== null);
      const words = run.result.words.map((word) => ({
        ...word,
        lexiconHit: lookupWord(lexicon, word.text),
      }));
      const annotated: OcrResult = { ...run.result, words };
      const summary = summarizeWords(words);

      setResult(annotated);
      setMetrics({
        initMs: run.initMs,
        preprocessMs: pre.elapsedMs,
        recognizeMs: run.recognizeMs,
        totalMs: performance.now() - totalStarted,
        imageWidth: pre.width,
        imageHeight: pre.height,
        wordCount: summary.count,
        avgConfidence: summary.avgConfidence,
        high: summary.high,
        mid: summary.mid,
        low: summary.low,
        known: summary.known,
        suspicious: summary.suspicious,
        filteredCount: run.result.filteredCount,
      });
      setStatus('done');

      if (reviewTask) {
        const outcome = await reviewTask;
        if (outcome.ok) {
          setReview(outcome.value);
          setAlignment(alignWords({ ocrWords: words, vlmWords: outcome.value.words }));
        } else {
          setReviewNote(outcome.error instanceof Error ? outcome.error.message : '云端复核失败');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
      setStatus('error');
    } finally {
      setProgress(null);
    }
  };

  const exportJson = () => {
    if (!source || !result || !metrics) return;

    const payload = {
      generatedAt: new Date().toISOString(),
      image: { name: source.name, width: source.width, height: source.height },
      config: {
        maxEdge,
        grayscale,
        engine: result.engine,
        engineVersion: result.engineVersion,
      },
      metrics,
      review,
      alignment,
      words: result.words.map((word) => ({
        id: word.id,
        text: word.text,
        confidence: Number(word.confidence.toFixed(3)),
        quad: word.quad,
        bbox: word.bbox,
      })),
      rawText: result.rawText,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ocr-${Date.now()}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSelect = useCallback((word: OcrWord) => {
    setSelectedId(word.id);
    if (isTrusted(word)) speakEnglish(word.text);
  }, []);

  const progressText = progress
    ? `${STATUS_TEXT[progress.status] ?? progress.status} ${Math.round(progress.progress * 100)}%`
    : '';

  return (
    <div className="app">
      {onApplyUpdate ? <UpdateBanner onUpdate={onApplyUpdate} /> : null}
      <header className="topbar">
        <div>
          <h1>英语点读</h1>
          <p className="sub">拍一页，点一个词库里的词，听慢读。</p>
        </div>
        <div className="segmented">
          <button type="button" className={view === 'read' ? 'active' : ''} onClick={() => setView('read')}>
            点读
          </button>
          <button type="button" className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>
            复习
          </button>
        </div>
      </header>

      {view === 'review' ? <ReviewPanel /> : null}

      <div className="layout" hidden={view !== 'read'}>
        <main className="stage-col">
          <div className="toolbar">
            <button onClick={() => setCameraOpen(true)}>拍照</button>
            <label className="btn-file">
              选图
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handleFile(file);
                }}
              />
            </label>
            <button
              onClick={() => void applyImage(`${import.meta.env.BASE_URL}samples/sample-page.png`, 'sample-page.png', false)}
            >
              示例图
            </button>
            <button className="primary" onClick={() => void runOcr()} disabled={!source || status === 'running'}>
              {status === 'running' ? '识别中…' : '运行识别'}
            </button>

            <div className="spacer" />

            <label className="select">
              长边
              <select value={maxEdge} onChange={(event) => setMaxEdge(Number(event.target.value))}>
                {MAX_EDGE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={grayscale}
                onChange={(event) => setGrayscale(event.target.checked)}
              />
              灰度预处理
            </label>
            {reviewAvailable ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={reviewEnabled}
                  onChange={(event) => setReviewEnabled(event.target.checked)}
                />
                云端语义复核
              </label>
            ) : null}
          </div>

          {progress && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress.progress * 100}%` }} />
              <span className="progress-text">{progressText}</span>
            </div>
          )}

          {error && <div className="alert">{error}</div>}

          {source ? (
            <ImageStage
              src={source.url}
              words={result?.words ?? []}
              selectedId={selectedId}
              filter={filter}
              onSelect={handleSelect}
            />
          ) : (
            <div className="empty-stage">
              <p className="empty-title">还没有照片</p>
              <p className="empty-desc">
                拍一页课本或绘本，或从相册选一张。
                <br />
                识别后点击词框可查看该词的置信度。
              </p>
            </div>
          )}

          {source && (
            <p className="source-meta">
              {source.name} · {source.width}×{source.height}
              {metrics ? ` · 输入 ${metrics.imageWidth}×${metrics.imageHeight}` : ''}
            </p>
          )}
        </main>

        <SidePanel
          metrics={metrics}
          words={result?.words ?? []}
          selectedId={selectedId}
          filter={filter}
          engineLabel="Tesseract.js 7 · WASM"
          engineVersion={result?.engineVersion ?? null}
          lexiconReady={lexiconReady}
          review={review}
          alignment={alignment}
          reviewNote={reviewNote}
          reviewEnabled={reviewEnabled}
          onFilterChange={setFilter}
          onSelect={handleSelect}
          onExport={exportJson}
          canExport={Boolean(result && metrics)}
          selected={result?.words.find((word) => word.id === selectedId) ?? null}
        />
      </div>

      <CameraSheet open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={(url) => void handleCapture(url)} />
    </div>
  );
}
