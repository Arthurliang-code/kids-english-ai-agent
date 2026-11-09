import { useEffect, useState } from 'react';
import { importVocabFile, listItems, putItem, toVocabFile } from '../../data/vocab-db';
import { dueItems, grade, todayISO, type ReviewItem } from '../../domain/review';
import { speakEnglish } from '../../speech/speak';
import { WordCard } from '../ocr-lab/WordCard';

export function ReviewPanel() {
  const [queue, setQueue] = useState<ReviewItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    const items = await listItems();
    setQueue(dueItems(items, todayISO()));
  };

  useEffect(() => {
    void reload();
  }, []);

  const current = queue?.[0] ?? null;

  const mark = async (correct: boolean) => {
    if (!current) return;
    if (!correct) speakEnglish(current.word);
    const next = grade(current, correct, todayISO());
    await putItem(next);
    setQueue((items) => {
      if (!items) return items;
      const rest = items.slice(1);
      return next.due <= todayISO() ? [next, ...rest] : rest;
    });
  };

  const exportFile = async () => {
    const file = toVocabFile(await listItems());
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vocab.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const items = await importVocabFile(parsed);
      if (!items) {
        setNote('这份文件不是生词本。');
        return;
      }
      setNote(null);
      await reload();
    } catch {
      setNote('这份文件读不出来。');
    }
  };

  return (
    <section className="review">
      <div className="card review-card">
        {queue === null ? (
          <p className="empty-hint">正在打开生词本…</p>
        ) : current ? (
          <>
            <p className="review-count">今天还有 {queue.length} 个</p>
            <WordCard text={current.word} trusted mode="review" />
            <div className="word-card-actions">
              <button className="kid-listen" type="button" onClick={() => void mark(true)}>
                会了
              </button>
              <button type="button" onClick={() => void mark(false)}>
                再听一遍
              </button>
            </div>
          </>
        ) : (
          <p className="kid-hello">今天的词都复习完了</p>
        )}
        {note ? <p className="footnote">{note}</p> : null}
      </div>
      <details className="parent-tools">
        <summary>爸爸妈妈</summary>
        <div className="word-card-actions">
          <button type="button" onClick={() => void exportFile()}>
            导出
          </button>
          <label className="kid-album">
            导回
            <input
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </label>
        </div>
      </details>
    </section>
  );
}
