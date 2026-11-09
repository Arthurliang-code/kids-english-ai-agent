import type { AlignedWord, OcrMetrics, OcrWord, VlmReview } from '@kea/shared-types';
import { bandOf, isTrusted } from '../../platform/core/classify';
import type { AlignResult } from '../../domain/align';
import { selectVisible, type WordFilter } from './ImageStage';
import { WordCard } from './WordCard';

interface SidePanelProps {
  metrics: OcrMetrics | null;
  words: OcrWord[];
  selectedId: string | null;
  filter: WordFilter;
  engineLabel: string;
  engineVersion: string | null;
  lexiconReady: boolean | null;
  review: VlmReview | null;
  alignment: AlignResult | null;
  reviewNote: string | null;
  reviewEnabled: boolean;
  onFilterChange: (filter: WordFilter) => void;
  onSelect: (word: OcrWord) => void;
  onExport: () => void;
  canExport: boolean;
  selected: OcrWord | null;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

export function SidePanel({
  metrics,
  words,
  selectedId,
  filter,
  engineLabel,
  engineVersion,
  lexiconReady,
  review,
  alignment,
  reviewNote,
  reviewEnabled,
  onFilterChange,
  onSelect,
  onExport,
  canExport,
  selected,
}: SidePanelProps) {
  const visible = selectVisible(words, filter);
  const wordById = new Map(words.map((word) => [word.id, word]));

  const handleVocabClick = (entry: AlignedWord) => {
    if (!entry.ocrWordId) return;
    const word = wordById.get(entry.ocrWordId);
    if (word) onSelect(word);
  };

  return (
    <aside className="side">
      {selected ? <WordCard text={selected.text} trusted={isTrusted(selected)} /> : null}
      <section className="card">
        <div className="card-head">
          <h2>识别指标</h2>
          <span className="engine-tag">{engineLabel}</span>
        </div>

        {metrics ? (
          <>
            <div className="metric-grid">
              <Metric label="总耗时" value={formatMs(metrics.totalMs)} strong />
              <Metric label="识别" value={formatMs(metrics.recognizeMs)} />
              <Metric label="预处理" value={formatMs(metrics.preprocessMs)} />
              <Metric label="引擎初始化" value={formatMs(metrics.initMs)} />
              <Metric label="词数" value={String(metrics.wordCount)} />
              <Metric label="平均置信" value={`${(metrics.avgConfidence * 100).toFixed(1)}%`} />
              <Metric
                label="词库命中"
                value={`${metrics.known}/${metrics.wordCount}`}
              />
              <Metric label="噪声已滤除" value={String(metrics.filteredCount)} />
            </div>

            <div className="band-bar" aria-label="置信度分布">
              <span className="seg high" style={{ flexGrow: metrics.high }} />
              <span className="seg mid" style={{ flexGrow: metrics.mid }} />
              <span className="seg low" style={{ flexGrow: metrics.low }} />
            </div>
            <div className="band-legend">
              <span>高 {metrics.high}</span>
              <span>中 {metrics.mid}</span>
              <span>低 {metrics.low}</span>
            </div>

            <p className="footnote">
              识别输入 {metrics.imageWidth}×{metrics.imageHeight}
              {engineVersion ? ` · tesseract ${engineVersion}` : ''}
              {lexiconReady === false ? ' · 词库未加载，未做词库校验' : ''}
            </p>
          </>
        ) : (
          <p className="empty-hint">选一张课本或绘本照片，点“运行识别”开始。</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>云端语义复核</h2>
          <span className="engine-tag">
            {!reviewEnabled ? '已关闭' : review ? review.model : '未返回'}
          </span>
        </div>

        {!reviewEnabled ? (
          <p className="empty-hint">已关闭，本次只用端侧结果。</p>
        ) : reviewNote ? (
          <p className="empty-hint">{reviewNote}</p>
        ) : !alignment ? (
          <p className="empty-hint">运行识别时自动请求，本地结果不受影响。</p>
        ) : (
          <>
            <div className="vocab-summary">
              <span>
                定位 <strong>{alignment.summary.located}</strong>
              </span>
              <span>
                纠正 <strong>{alignment.summary.corrected}</strong>
              </span>
              <span>
                仅词表 <strong>{alignment.summary.vocabularyOnly}</strong>
              </span>
            </div>

            <div className="vocab-list">
              {alignment.words.map((entry, index) => (
                <button
                  key={`${entry.text}-${index}`}
                  className={`vocab-row${entry.ocrWordId ? '' : ' is-static'}${entry.teach ? '' : ' is-muted'}`}
                  disabled={!entry.ocrWordId}
                  onClick={() => handleVocabClick(entry)}
                >
                  <span className="vocab-text">{entry.text}</span>
                  {entry.count > 1 && <span className="vocab-count">×{entry.count}</span>}
                  {entry.ocrText && <span className="vocab-ocr">← {entry.ocrText}</span>}
                  <span className={`vocab-tag ${entry.status}`}>
                    {entry.status === 'exact' ? '定位' : entry.status === 'corrected' ? '纠正' : '仅词表'}
                  </span>
                </button>
              ))}
            </div>

            <p className="footnote">
              {review?.level ? `${review.level} · ` : ''}
              {review ? `${Math.round(review.latencyMs)} ms` : ''}
              {review?.totalTokens ? ` · ${review.totalTokens} tokens` : ''}
              {review?.uncertain.length ? ` · 不确定 ${review.uncertain.length} 处` : ''}
            </p>
          </>
        )}
      </section>

      <section className="card grow">
        <div className="card-head">
          <h2>词表</h2>
          <div className="segmented">
            <button
              className={filter === 'trusted' ? 'active' : ''}
              onClick={() => onFilterChange('trusted')}
            >
              可教学
            </button>
            <button
              className={filter === 'suspicious' ? 'active' : ''}
              onClick={() => onFilterChange('suspicious')}
            >
              可疑{metrics ? ` ${metrics.suspicious}` : ''}
            </button>
            <button
              className={filter === 'all' ? 'active' : ''}
              onClick={() => onFilterChange('all')}
            >
              全部
            </button>
          </div>
        </div>

        <div className="word-list">
          {visible.length === 0 ? (
            <p className="empty-hint">
              {words.length === 0
                ? '暂无识别结果'
                : filter === 'trusted'
                  ? '没有命中词库的词'
                  : '没有可疑词'}
            </p>
          ) : (
            visible.map((word) => {
              const band = bandOf(word.confidence);
              return (
                <button
                  key={word.id}
                  className={`word-row${word.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => onSelect(word)}
                >
                  <span className={`dot ${band}`} />
                  <span className="word-text">{word.text}</span>
                  <span className="word-conf">{(word.confidence * 100).toFixed(0)}%</span>
                </button>
              );
            })
          )}
        </div>

        <button className="ghost full" onClick={onExport} disabled={!canExport}>
          导出本次结果 JSON
        </button>
      </section>
    </aside>
  );
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`metric${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
