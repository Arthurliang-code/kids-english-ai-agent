import { useEffect, useState } from 'react';
import { lookupGlossary } from '../../content/glossary';
import { getItem, getTake, putItem, putTake } from '../../data/vocab-db';
import { newItem, todayISO } from '../../domain/review';
import { recordClip } from '../../speech/record';
import { speakEnglish, stopSpeaking } from '../../speech/speak';

interface WordCardProps {
  text: string;
  trusted: boolean;
}

export function WordCard({ text, trusted }: WordCardProps) {
  const entry = lookupGlossary(text);
  const [saved, setSaved] = useState(false);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSaved(false);
    setTakeUrl(null);
    setNote(null);
    void (async () => {
      const item = await getItem(text);
      const take = await getTake(text);
      if (cancelled) return;
      if (item) setSaved(true);
      if (take) {
        objectUrl = URL.createObjectURL(take);
        setTakeUrl(objectUrl);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [text]);

  const save = async () => {
    await putItem(newItem(text, todayISO()));
    setSaved(true);
  };

  const startRecording = () => {
    stopSpeaking();
    setNote(null);
    const clip = recordClip();
    setRecording(true);
    void clip.done
      .then(async (blob) => {
        await putTake(text, blob);
        setTakeUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });
      })
      .catch(() => setNote('没有拿到麦克风，可以在设置里允许后再读一遍。'))
      .finally(() => setRecording(false));
  };

  return (
    <section className="card word-card">
      <p className="word-card-text">{text}</p>
      {trusted ? (
        <>
          <p className="word-card-meaning">{entry ? entry.meaning : '还没有释义'}</p>
          {entry ? <p className="word-card-example">{entry.example}</p> : null}
          <div className="word-card-actions">
            <button className="primary" type="button" onClick={() => speakEnglish(text)}>
              听一遍
            </button>
            <button type="button" onClick={() => void save()} disabled={saved}>
              {saved ? '已在生词本' : '收入生词本'}
            </button>
            <button type="button" onClick={startRecording} disabled={recording}>
              {recording ? '正在听…' : '我来读'}
            </button>
            <button
              type="button"
              disabled={!takeUrl}
              onClick={() => {
                if (!takeUrl) return;
                const audio = new Audio(takeUrl);
                void audio.play();
              }}
            >
              听我的
            </button>
          </div>
          {note ? <p className="footnote">{note}</p> : null}
        </>
      ) : (
        <p className="word-card-meaning">词库里没有这个词，先不读。</p>
      )}
    </section>
  );
}
