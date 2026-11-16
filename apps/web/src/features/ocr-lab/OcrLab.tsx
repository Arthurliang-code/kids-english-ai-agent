import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OcrResult, OcrSentence, OcrWord } from '@kea/shared-types';
import { pretranslatePageSentences } from '../../content/translate';
import { loadLexicon, lookupWord } from '../../domain/lexicon';
import { buildSentences, findSentenceForWord } from '../../domain/sentence';
import { isTrusted } from '../../platform/core/classify';
import type { OcrEngine } from '../../platform/core/types';
import { loadImage, preprocess } from '../../platform/web/ocr/preprocess';
import { TesseractEngine } from '../../platform/web/ocr/tesseract-engine';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import {
  getPreferredAccent,
  setPreferredAccent,
  speakEnglish,
  speakSentence,
  stopSpeaking,
  type EnglishAccent,
} from '../../speech/speak';
import { ReviewPanel } from '../review/ReviewPanel';
import { CameraSheet } from './CameraSheet';
import { ImageStage, type StageInteractionMode } from './ImageStage';
import { SentenceCard } from './SentenceCard';
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
  const [stageMode, setStageMode] = useState<StageInteractionMode>('word');
  const [accent, setAccent] = useState<EnglishAccent>(() => getPreferredAccent());
  const [selected, setSelected] = useState<OcrWord | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<OcrSentence | null>(null);
  const [speakingWordIndex, setSpeakingWordIndex] = useState<number | null>(null);
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
    stopSpeaking();
    setSource({ url, fromObjectUrl });
    setStatus('running');
    setScanLabel('正在认字…');
    setError(null);
    setResult(null);
    setSelected(null);
    setSelectedSentence(null);
    setSpeakingWordIndex(null);

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
      const sentences = buildSentences(words, run.result.lines, isTrusted);
      setResult({ ...run.result, words, sentences });
      setStatus('done');

      const trustedSentenceTexts = sentences.filter((s) => s.trusted).map((s) => s.text);
      void pretranslatePageSentences(trustedSentenceTexts);
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

  const sentences = result?.sentences ?? [];
  const words = result?.words ?? [];

  const wordMap = useMemo(() => {
    const map = new Map<string, OcrWord>();
    for (const w of words) map.set(w.id, w);
    return map;
  }, [words]);

  const activeSentence = useMemo(() => {
    if (selectedSentence) return selectedSentence;
    if (selected) return findSentenceForWord(sentences, selected.id);
    return null;
  }, [selected, selectedSentence, sentences]);

  const activeSentenceWords = useMemo(() => {
    if (!activeSentence) return [];
    return activeSentence.wordIds
      .map((id) => wordMap.get(id))
      .filter((w): w is OcrWord => w !== undefined);
  }, [activeSentence, wordMap]);

  const speakingWordId = useMemo(() => {
    if (speakingWordIndex === null || !activeSentence) return null;
    return activeSentence.wordIds[speakingWordIndex] ?? null;
  }, [activeSentence, speakingWordIndex]);

  const handleChangeAccent = useCallback((nextAccent: EnglishAccent) => {
    setPreferredAccent(nextAccent);
    setAccent(nextAccent);
  }, []);

  const handleSelectWord = useCallback(
    (word: OcrWord) => {
      if (!isTrusted(word)) return;
      setSpeakingWordIndex(null);
      setSelectedSentence(null);
      setSelected(word);
      speakEnglish(word.text, accent);
    },
    [accent],
  );

  const handleSelectSentence = useCallback(
    (sentence: OcrSentence) => {
      if (!sentence.trusted) return;
      setSelected(null);
      setSelectedSentence(sentence);
      speakSentence(sentence.text, {
        accent,
        slow: false,
        onWordIndex: setSpeakingWordIndex,
      });
    },
    [accent],
  );

  const handleSwitchStageMode = (nextMode: StageInteractionMode) => {
    if (nextMode === stageMode) return;
    stopSpeaking();
    setSpeakingWordIndex(null);
    setStageMode(nextMode);
    if (nextMode === 'sentence') {
      if (selected) {
        const matched = findSentenceForWord(sentences, selected.id);
        setSelected(null);
        setSelectedSentence(matched);
      }
    } else if (selectedSentence) {
      setSelectedSentence(null);
    }
  };

  const trustedCount = words.filter(isTrusted).length;
  const trustedSentenceCount = sentences.filter((s) => s.trusted).length;
  const hasCardOpen = Boolean(selected || selectedSentence);

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
            onClick={() => {
              stopSpeaking();
              setView('review');
            }}
          >
            ⭐ 复习
          </button>
        </nav>

        <div className="accent-switch" role="group" aria-label="英语口音切换">
          <button
            type="button"
            className={`accent-pill${accent === 'uk' ? ' active' : ''}`}
            aria-pressed={accent === 'uk'}
            onClick={() => handleChangeAccent('uk')}
          >
            🇬🇧 英式
          </button>
          <button
            type="button"
            className={`accent-pill${accent === 'us' ? ' active' : ''}`}
            aria-pressed={accent === 'us'}
            onClick={() => handleChangeAccent('us')}
          >
            🇺🇸 美式
          </button>
        </div>
      </header>

      <main className="app-main">
        {view === 'review' ? <ReviewPanel /> : null}

        <div className="kid-read" hidden={view !== 'read'}>
          {source ? (
            <div className={`kid-workspace${hasCardOpen ? ' has-selection' : ''}`}>
              <div className="kid-stage-area">
                {status === 'done' && (trustedCount > 0 || trustedSentenceCount > 0) ? (
                  <div className="stage-mode-bar" role="group" aria-label="点读粒度切换">
                    <button
                      type="button"
                      className={`stage-mode-btn${stageMode === 'word' ? ' active' : ''}`}
                      aria-pressed={stageMode === 'word'}
                      onClick={() => handleSwitchStageMode('word')}
                    >
                      🔤 点单词
                    </button>
                    <button
                      type="button"
                      className={`stage-mode-btn${stageMode === 'sentence' ? ' active' : ''}`}
                      aria-pressed={stageMode === 'sentence'}
                      disabled={trustedSentenceCount === 0}
                      onClick={() => handleSwitchStageMode('sentence')}
                    >
                      📖 读整句
                    </button>
                  </div>
                ) : null}

                <div className="kid-page">
                  <ImageStage
                    src={source.url}
                    words={words}
                    sentences={sentences}
                    stageMode={stageMode}
                    selectedId={selected?.id ?? null}
                    selectedSentenceId={activeSentence?.id ?? null}
                    speakingWordId={speakingWordId}
                    filter="trusted"
                    scanning={status === 'running'}
                    scanLabel={scanLabel}
                    onSelect={handleSelectWord}
                    onSelectSentence={handleSelectSentence}
                  />
                  {status === 'done' && trustedCount > 0 && !hasCardOpen ? (
                    <p className="kid-tip">
                      {stageMode === 'sentence'
                        ? '👆 点一页里的蓝色整句框，听整句发音与中文意思'
                        : '👆 点一页里的绿色词框，听单词和所在整句'}
                    </p>
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
                      accent={accent}
                      onAccentChange={handleChangeAccent}
                      selectedWordId={selected.id}
                      pageSentence={activeSentence}
                      sentenceWords={activeSentenceWords}
                      speakingWordIndex={speakingWordIndex}
                      onSpeakingWordIndexChange={setSpeakingWordIndex}
                      onSelectWord={handleSelectWord}
                      onClose={() => {
                        setSpeakingWordIndex(null);
                        setSelected(null);
                      }}
                    />
                  </div>
                </aside>
              ) : selectedSentence ? (
                <aside className="kid-card-panel" aria-label="整句卡片">
                  <div className="kid-sheet">
                    <SentenceCard
                      sentence={selectedSentence}
                      sentenceWords={activeSentenceWords}
                      accent={accent}
                      onAccentChange={handleChangeAccent}
                      speakingWordIndex={speakingWordIndex}
                      onSpeakingWordIndexChange={setSpeakingWordIndex}
                      onSelectWord={handleSelectWord}
                      onClose={() => {
                        setSpeakingWordIndex(null);
                        setSelectedSentence(null);
                      }}
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
