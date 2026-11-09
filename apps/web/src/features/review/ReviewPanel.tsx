import { useEffect, useState } from 'react';
import { lookupGlossary } from '../../content/glossary';
import { getTake, importVocabFile, listItems, putItem, putTake, toVocabFile } from '../../data/vocab-db';
import { dueItems, grade, todayISO, type ReviewItem } from '../../domain/review';
import { recordClip } from '../../speech/record';
import { speakEnglish, stopSpeaking } from '../../speech/speak';

export function ReviewPanel() {
  const [queue, setQueue] = useState<ReviewItem[] | null>(null);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    const items = await listItems();
    setQueue(dueItems(items, todayISO()));
  };

  useEffect(() => {
    void reload();
  }, []);

  const current = queue?.[0] ?? null;

  useEffect(() => {
    let url: string | null = null;
    setTakeUrl(null);
    if (!current) return;
    void getTake(current.word).then((blob) => {
      if (!blob) return;
      url = URL.createObjectURL(blob);
      setTakeUrl(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [current]);

  const mark = async (correct: boolean) => {
    if (!current) return;
    const next = grade(current, correct, todayISO());
    await putItem(next);
    setQueue((items) => {
      if (!items) return items;
      const rest = items.slice(1);
      return next.due <= todayISO() ? [next, ...rest] : rest;
    });
  };

  const startRecording = () => {
    if (!current) return;
    stopSpeaking();
    const clip = recordClip();
    setRecording(true);
    void clip.done
      .then(async (blob) => {
        await putTake(current.word, blob);
        setTakeUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });
      })
      .catch(() => setNote('请打开麦克风，再说一遍。'))
      .finally(() => setRecording(false));
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
        setNote('这份 JSON 不是生词本导出的格式。');
        return;
      }
      setNote(null);
      await reload();
    } catch {
      setNote('这份文件读不出来。');
    }
  };

  const entry = current ? lookupGlossary(current.word) : null;

  return (
    <section className="review">
      <div className="card review-card">
        {queue === null ? (
          <p className="empty-hint">正在打开生词本…</p>
        ) : current ? (
          <>
            <p className="review-count">今天还有 {queue.length} 个</p>
            <p className="word-card-text">{current.word}</p>
            {entry ? <p className="word-card-meaning">{entry.meaning}</p> : null}
            {entry ? <p className="word-card-example">{entry.example}</p> : null}
            <div className="word-card-actions">
              <button className="kid-listen" type="button" onClick={() => speakEnglish(current.word)}>
                听一听
              </button>
              <button type="button" onClick={startRecording} disabled={recording}>
                {recording ? '正在听你读…' : '我来读'}
              </button>
              <button
                type="button"
                disabled={!takeUrl}
                onClick={() => {
                  if (!takeUrl) return;
                  void new Audio(takeUrl).play();
                }}
              >
                听我读的
              </button>
            </div>
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
