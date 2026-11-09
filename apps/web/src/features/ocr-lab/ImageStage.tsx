import { useEffect, useRef } from 'react';
import type { OcrWord } from '@kea/shared-types';
import { expandQuad, toSvgPoints } from '../../domain/box';
import { isSuspicious, isTrusted } from '../../platform/core/classify';

export type WordFilter = 'trusted' | 'suspicious' | 'all';

interface ImageStageProps {
  src: string;
  words: OcrWord[];
  selectedId: string | null;
  filter: WordFilter;
  scanning?: boolean;
  scanLabel?: string;
  onSelect: (word: OcrWord) => void;
}

export function selectVisible(words: OcrWord[], filter: WordFilter): OcrWord[] {
  if (filter === 'all') return words;
  if (filter === 'trusted') return words.filter(isTrusted);
  return words.filter(isSuspicious);
}

export function ImageStage({
  src,
  words,
  selectedId,
  filter,
  scanning = false,
  scanLabel = '正在认字，马上就好…',
  onSelect,
}: ImageStageProps) {
  const visible = selectVisible(words, filter);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!selectedId || !svgRef.current) return;
    const active = svgRef.current.querySelector<SVGPolygonElement>(
      `[data-word-id="${CSS.escape(selectedId)}"]`,
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <div className={`stage${scanning ? ' is-scanning' : ''}`}>
      <img src={src} alt="课本书页" draggable={false} />
      <svg
        ref={svgRef}
        className="overlay"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-label="可点读的单词框"
      >
        {visible.map((word) => {
          const selected = word.id === selectedId;
          const padded = expandQuad(word.quad);
          return (
            <polygon
              key={word.id}
              data-word-id={word.id}
              points={toSvgPoints(padded)}
              className={`word-box${selected ? ' is-selected' : ''}`}
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
        })}
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
