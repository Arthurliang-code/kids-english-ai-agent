import { useEffect, useRef } from 'react';
import type { OcrSentence, OcrWord } from '@kea/shared-types';
import { expandQuad, toSvgPoints } from '../../domain/box';
import { isSuspicious, isTrusted } from '../../platform/core/classify';

export type WordFilter = 'trusted' | 'suspicious' | 'all';
export type StageInteractionMode = 'word' | 'sentence';

interface ImageStageProps {
  src: string;
  words: OcrWord[];
  sentences?: OcrSentence[];
  stageMode?: StageInteractionMode;
  selectedId: string | null;
  selectedSentenceId?: string | null;
  speakingWordId?: string | null;
  filter: WordFilter;
  scanning?: boolean;
  scanLabel?: string;
  onSelect: (word: OcrWord) => void;
  onSelectSentence?: (sentence: OcrSentence) => void;
}

export function selectVisible(words: OcrWord[], filter: WordFilter): OcrWord[] {
  if (filter === 'all') return words;
  if (filter === 'trusted') return words.filter(isTrusted);
  return words.filter(isSuspicious);
}

export function ImageStage({
  src,
  words,
  sentences = [],
  stageMode = 'word',
  selectedId,
  selectedSentenceId = null,
  speakingWordId = null,
  filter,
  scanning = false,
  scanLabel = '正在认字，马上就好…',
  onSelect,
  onSelectSentence,
}: ImageStageProps) {
  const visible = selectVisible(words, filter);
  const trustedSentences = sentences.filter((s) => s.trusted);
  const activeSentence = sentences.find((s) => s.id === selectedSentenceId) ?? null;
  const sentenceWordIdSet = new Set(activeSentence?.wordIds ?? []);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;
    const selector =
      stageMode === 'sentence' && selectedSentenceId
        ? `[data-sentence-id="${CSS.escape(selectedSentenceId)}"]`
        : selectedId
          ? `[data-word-id="${CSS.escape(selectedId)}"]`
          : null;
    if (!selector) return;
    const active = svgRef.current.querySelector<SVGPolygonElement>(selector);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedId, selectedSentenceId, stageMode]);

  return (
    <div className={`stage${scanning ? ' is-scanning' : ''}`}>
      <img src={src} alt="课本书页" draggable={false} />
      <svg
        ref={svgRef}
        className="overlay"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-label={stageMode === 'sentence' ? '可点读的整句框' : '可点读的单词框'}
      >
        {stageMode === 'sentence'
          ? trustedSentences.map((sentence) => {
              const selected = sentence.id === selectedSentenceId;
              const padded = expandQuad(sentence.quad, 0.008, 0.008);
              return (
                <polygon
                  key={sentence.id}
                  data-sentence-id={sentence.id}
                  points={toSvgPoints(padded)}
                  className={`sentence-box${selected ? ' is-selected' : ''}`}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  role="button"
                  tabIndex={0}
                  aria-label={sentence.text}
                  aria-pressed={selected}
                  onPointerDown={(event) => {
                    onSelectSentence?.(sentence);
                    event.preventDefault();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      onSelectSentence?.(sentence);
                    } else if (event.key === ' ') {
                      event.preventDefault();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === ' ') {
                      onSelectSentence?.(sentence);
                    }
                  }}
                >
                  <title>{sentence.text}</title>
                </polygon>
              );
            })
          : null}

        {stageMode === 'word'
          ? visible.map((word) => {
              const selected = word.id === selectedId;
              const inSentence = !selected && sentenceWordIdSet.has(word.id);
              const speaking = word.id === speakingWordId;
              const padded = expandQuad(word.quad);
              return (
                <polygon
                  key={word.id}
                  data-word-id={word.id}
                  points={toSvgPoints(padded)}
                  className={`word-box${selected ? ' is-selected' : ''}${inSentence ? ' in-sentence' : ''}${speaking ? ' is-speaking' : ''}`}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  role="button"
                  tabIndex={0}
                  aria-label={word.text}
                  aria-pressed={selected}
                  onPointerDown={(event) => {
                    onSelect(word);
                    event.preventDefault();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      onSelect(word);
                    } else if (event.key === ' ') {
                      event.preventDefault();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === ' ') {
                      onSelect(word);
                    }
                  }}
                >
                  <title>{word.text}</title>
                </polygon>
              );
            })
          : null}

        {stageMode === 'sentence' && speakingWordId
          ? visible
              .filter((w) => w.id === speakingWordId)
              .map((word) => (
                <polygon
                  key={`speak-${word.id}`}
                  points={toSvgPoints(expandQuad(word.quad))}
                  className="word-box is-speaking pointer-none"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              ))
          : null}
      </svg>
      {scanning ? (
        <div className="stage-scan" role="status" aria-live="polite">
          <div className="stage-scan-line" aria-hidden="true" />
          <span className="stage-scan-pill">{scanLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
