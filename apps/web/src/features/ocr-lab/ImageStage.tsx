import type { OcrWord, Quad } from '@kea/shared-types';
import { bandOf, isSuspicious, isTrusted } from '../../platform/core/classify';

export type WordFilter = 'trusted' | 'suspicious' | 'all';

interface ImageStageProps {
  src: string;
  words: OcrWord[];
  selectedId: string | null;
  filter: WordFilter;
  onSelect: (word: OcrWord) => void;
}

function toPoints(quad: Quad): string {
  return quad.map((point) => `${point.x},${point.y}`).join(' ');
}

export function selectVisible(words: OcrWord[], filter: WordFilter): OcrWord[] {
  if (filter === 'all') return words;
  if (filter === 'trusted') return words.filter(isTrusted);
  return words.filter(isSuspicious);
}

export function ImageStage({ src, words, selectedId, filter, onSelect }: ImageStageProps) {
  const visible = selectVisible(words, filter);

  return (
    <div className="stage">
      <img src={src} alt="待识别原图" draggable={false} />
      <svg className="overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
        {visible.map((word) => {
          const band = bandOf(word.confidence);
          const selected = word.id === selectedId;
          return (
            <polygon
              key={word.id}
              points={toPoints(word.quad)}
              className={`word-box band-${band}${selected ? ' is-selected' : ''}`}
              vectorEffect="non-scaling-stroke"
              onPointerDown={(event) => {
                event.preventDefault();
                onSelect(word);
              }}
            >
              <title>{`${word.text} · ${(word.confidence * 100).toFixed(0)}%`}</title>
            </polygon>
          );
        })}
      </svg>
    </div>
  );
}
