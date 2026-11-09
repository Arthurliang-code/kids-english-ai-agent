import { useEffect, useState } from 'react';
import { resolveSense } from '../../content/lookup';
import { getItem, getTake, putItem, putTake } from '../../data/vocab-db';
import type { GlossaryEntry } from '../../domain/glossary';
import { newItem, todayISO } from '../../domain/review';
import { recordClip } from '../../speech/record';
import { speakEnglish, stopSpeaking } from '../../speech/speak';

interface WordCardProps {
  text: string;
  trusted: boolean;
}

export function WordCard({ text, trusted }: WordCardProps) {
  const [sense, setSense] = useState<GlossaryEntry | null>(null);
  const [loading, setLoading] = useState(true);
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
    setSense(null);
    setLoading(true);
    void (async () => {
      const [item, take, next] = await Promise.all([
        getItem(text),
        getTake(text),
        trusted ? resolveSense(text) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (item) setSaved(true);
      if (take) {
        objectUrl = URL.createObjectURL(take);
        setTakeUrl(objectUrl);
      }
      setSense(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [text, trusted]);

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
      .catch(() => setNote('请打开麦克风，再说一遍。'))
      .finally(() => setRecording(false));
  };

  if (!trusted) {
    return (
      <section className="word-card">
        <p className="word-card-text">{text}</p>
        <p className="word-card-meaning">这个先不读。</p>
      </section>
    );
  }

  return (
    <section className="word-card">
      <p className="word-card-text">{text}</p>
      {sense?.phonetic ? <p className="word-card-phonetic">{sense.phonetic}</p> : null}

      <div className="word-sense">
        <p className="word-sense-label">读音</p>
        <button className="kid-listen" type="button" onClick={() => speakEnglish(text)}>
          听单词
        </button>
      </div>

      <div className="word-sense">
        <p className="word-sense-label">解释</p>
        <p className="word-card-meaning">{loading ? '正在找这个词…' : sense?.meaning}</p>
      </div>

      <div className="word-sense">
        <p className="word-sense-label">举例</p>
        <p className="word-card-example">{loading ? '…' : sense?.example}</p>
        {sense?.example ? (
          <button type="button" onClick={() => speakEnglish(sense.example)}>
            听句子
          </button>
        ) : null}
      </div>

      <div className="word-card-actions">
        <button type="button" onClick={() => void save()} disabled={saved}>
          {saved ? '记下了' : '记下来'}
        </button>
        <button type="button" onClick={startRecording} disabled={recording}>
          {recording ? '正在听你读…' : '我来读'}
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
          听我读的
        </button>
      </div>
      {note ? <p className="footnote">{note}</p> : null}
    </section>
  );
}
