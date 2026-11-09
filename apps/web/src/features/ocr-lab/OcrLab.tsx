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
  width: number;
  height: number;
  fromObjectUrl: boolean;
}

export function OcrLab({ onApplyUpdate }: { onApplyUpdate: (() => void) | null }) {
  const [source, setSource] = useState<Source | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OcrWord | null>(null);
  const [view, setView] = useState<'read' | 'review'>('read');
  const engineRef = useRef<OcrEngine | null>(null);
  const runId = useRef(0);

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

  const recognize = async (next: Source) => {
    const id = ++runId.current;
    setStatus('running');
    setError(null);
    setResult(null);
    setSelected(null);

    try {
      const image = await loadImage(next.url);
      const pre = await preprocess(image, { maxEdge: 2048, grayscale: true });
      const engine = (engineRef.current ??= new TesseractEngine());
      const run = await engine.run({ canvas: pre.canvas });
      if (id !== runId.current) return;

      const lexicon = await loadLexicon();
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
  };

  const applyImage = useCallback(async (url: string, fromObjectUrl: boolean) => {
    const image = await loadImage(url);
    const next = { url, width: image.naturalWidth, height: image.naturalHeight, fromObjectUrl };
    setSource(next);
    await recognize(next);
  }, []);

  const handleFile = async (file: File) => {
    await applyImage(URL.createObjectURL(file), true);
  };

  const handleCapture = async (dataUrl: string) => {
    setCameraOpen(false);
    await applyImage(dataUrl, false);
  };

  const handleSelect = useCallback((word: OcrWord) => {
    if (!isTrusted(word)) return;
    setSelected(word);
    speakEnglish(word.text);
  }, []);

  return (
    <div className="app">
      {onApplyUpdate ? <UpdateBanner onUpdate={onApplyUpdate} /> : null}
      <header className="kid-bar">
        <button type="button" className={view === 'read' ? 'active' : ''} onClick={() => setView('read')}>
          点读
        </button>
        <button type="button" className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>
          复习
        </button>
      </header>

      {view === 'review' ? <ReviewPanel /> : null}

      <div className="kid-read" hidden={view !== 'read'}>
        {source ? (
          <div className="kid-page">
            <ImageStage
              src={source.url}
              words={result?.words ?? []}
              selectedId={selected?.id ?? null}
              filter="trusted"
              onSelect={handleSelect}
            />
            {status === 'running' ? <p className="kid-status">正在认字…</p> : null}
            {error ? <p className="kid-alert">{error}</p> : null}
            {status === 'done' && (result?.words.filter(isTrusted).length ?? 0) === 0 ? (
              <p className="kid-alert">没有认出能读的词，把书放平再拍一次。</p>
            ) : null}
          </div>
        ) : (
          <div className="kid-home">
            <p className="kid-hello">把课本对着平板</p>
            <button className="kid-camera" type="button" onClick={() => setCameraOpen(true)}>
              拍一页
            </button>
            <label className="kid-album">
              从相册选
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

        {source ? (
          <div className="kid-dock">
            <button className="kid-camera small" type="button" onClick={() => setCameraOpen(true)}>
              再拍一页
            </button>
            <label className="kid-album">
              换一张
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
        ) : null}
      </div>

      {selected ? (
        <div className="kid-sheet-backdrop" onClick={() => setSelected(null)}>
          <div className="kid-sheet" onClick={(event) => event.stopPropagation()}>
            <WordCard text={selected.text} trusted />
            <button className="kid-close" type="button" onClick={() => setSelected(null)}>
              好了
            </button>
          </div>
        </div>
      ) : null}

      <CameraSheet open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={(url) => void handleCapture(url)} />
    </div>
  );
}
