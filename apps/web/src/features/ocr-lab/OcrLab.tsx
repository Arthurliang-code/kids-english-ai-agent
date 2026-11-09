import { useCallback, useEffect, useRef, useState } from 'react';
import type { OcrResult, OcrWord } from '@kea/shared-types';
import type { OcrEngine } from '../../platform/core/types';
import { isTrusted } from '../../platform/core/classify';
import { loadLexicon, lookupWord } from '../../domain/lexicon';
import { TesseractEngine } from '../../platform/web/ocr/tesseract-engine';
import { loadImage, preprocess } from '../../platform/web/ocr/preprocess';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import { speakEnglish } from '../../speech/speak';
import { ReviewPanel } from '../review/ReviewPanel';
import { CameraSheet } from './CameraSheet';
import { ImageStage } from './ImageStage';
import { WordCard } from './WordCard';

type RunStatus = 'idle' | 'running' | 'done' | 'error';

interface Source {
  url: string;
  fromObjectUrl: boolean;
}

const OCR_MAX_EDGE = 1600;

export function OcrLab({ onApplyUpdate }: { onApplyUpdate: (() => void) | null }) {
  const [source, setSource] = useState<Source | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [scanLabel, setScanLabel] = useState('正在认字，马上就好…');
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OcrWord | null>(null);
  const [view, setView] = useState<'read' | 'review'>('read');
  const engineRef = useRef<OcrEngine | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    const engine = new TesseractEngine();
    engineRef.current = engine;
    void engine.warm?.();
    void loadLexicon();
    return () => {
      void engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (source?.fromObjectUrl) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  const applyImage = useCallback(async (url: string, fromObjectUrl: boolean) => {
    const id = ++runId.current;
    setSource({ url, fromObjectUrl });
    setStatus('running');
    setScanLabel('正在认字…');
    setError(null);
    setResult(null);
    setSelected(null);

    try {
      const [image, lexicon] = await Promise.all([loadImage(url), loadLexicon()]);
      if (id !== runId.current) return;

      const pre = await preprocess(image, { maxEdge: OCR_MAX_EDGE, grayscale: true });
      if (id !== runId.current) return;

      const engine = (engineRef.current ??= new TesseractEngine());
      const run = await engine.run(
        { canvas: pre.canvas, imageBytes: pre.imageBytes },
        (progress) => {
          if (id !== runId.current) return;
          if (progress.status === 'recognizing text') {
            const pct = Math.round(progress.progress * 100);
            setScanLabel(pct > 0 ? `正在认字 ${pct}%…` : '正在认字…');
          } else {
            setScanLabel('正在准备认字引擎…');
          }
        },
      );
      if (id !== runId.current) return;

      const words = run.result.words.map((word) => ({
        ...word,
        lexiconHit: lookupWord(lexicon, word.text),
      }));
      setResult({ ...run.result, words });
      setStatus('done');
    } catch {
      if (id !== runId.current) return;
      setError('这一页看不清，再拍一次吧。');
      setStatus('error');
    }
  }, []);

  const handleFile = async (file: File) => {
    await applyImage(URL.createObjectURL(file), true);
  };

  const handleCapture = async (url: string, fromObjectUrl: boolean) => {
    setCameraOpen(false);
    await applyImage(url, fromObjectUrl);
  };

  const handleSelect = useCallback((word: OcrWord) => {
    if (!isTrusted(word)) return;
    setSelected(word);
    speakEnglish(word.text);
  }, []);

  const trustedCount = result?.words.filter(isTrusted).length ?? 0;

  return (
    <div className="app">
      {onApplyUpdate ? <UpdateBanner onUpdate={onApplyUpdate} /> : null}
      <header className="kid-bar">
        <nav className="kid-nav" aria-label="功能切换">
          <button
            type="button"
            className={view === 'read' ? 'active' : ''}
            aria-pressed={view === 'read'}
            onClick={() => setView('read')}
          >
            📖 点读
          </button>
          <button
            type="button"
            className={view === 'review' ? 'active' : ''}
            aria-pressed={view === 'review'}
            onClick={() => setView('review')}
          >
            ⭐ 复习
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === 'review' ? <ReviewPanel /> : null}

        <div className="kid-read" hidden={view !== 'read'}>
          {source ? (
            <div className={`kid-workspace${selected ? ' has-selection' : ''}`}>
              <div className="kid-stage-area">
                <div className="kid-page">
                  <ImageStage
                    src={source.url}
                    words={result?.words ?? []}
                    selectedId={selected?.id ?? null}
                    filter="trusted"
                    scanning={status === 'running'}
                    scanLabel={scanLabel}
                    onSelect={handleSelect}
                  />
                  {status === 'done' && trustedCount > 0 && !selected ? (
                    <p className="kid-tip">👆 点一页里的绿色词框，听读音、看解释</p>
                  ) : null}
                  {error ? <p className="kid-alert">{error}</p> : null}
                  {status === 'done' && trustedCount === 0 ? (
                    <p className="kid-alert">没有认出能读的词，把书放平再拍一次。</p>
                  ) : null}
                </div>

                <div className="kid-dock">
                  <button
                    className="kid-camera small"
                    type="button"
                    onClick={() => setCameraOpen(true)}
                  >
                    📷 再拍一页
                  </button>
                  <label className="kid-album">
                    🖼️ 换一张
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
                </div>
              </div>

              {selected ? (
                <aside className="kid-card-panel" aria-label="单词卡片">
                  <div className="kid-sheet">
                    <WordCard
                      text={selected.text}
                      trusted
                      mode="lookup"
                      onClose={() => setSelected(null)}
                    />
                  </div>
                </aside>
              ) : null}
            </div>
          ) : (
            <div className="kid-home">
              <p className="kid-hello">把课本对着平板</p>
              <button className="kid-camera" type="button" onClick={() => setCameraOpen(true)}>
                📷 拍一页
              </button>
              <label className="kid-album">
                🖼️ 从相册选
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
                className="kid-sample"
                type="button"
                onClick={() =>
                  void applyImage(`${import.meta.env.BASE_URL}samples/sample-page.png`, false)
                }
              >
                看一页例子
              </button>
            </div>
          )}
        </div>
      </main>

      <CameraSheet
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(url, fromObjectUrl) => void handleCapture(url, fromObjectUrl)}
        onPickFile={(file) => void handleFile(file)}
      />
    </div>
  );
}
