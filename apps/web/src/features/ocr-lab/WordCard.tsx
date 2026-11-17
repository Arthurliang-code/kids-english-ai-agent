import { useEffect, useRef, useState } from 'react';
import type { OcrSentence, OcrWord } from '@kea/shared-types';
import { enrichSense, resolveSense } from '../../content/lookup';
import {
  resolveSentenceLocal,
  translateSentenceWithAi,
  type SentenceTranslationResult,
} from '../../content/translate';
import { getItem, getTake, putItem, putTake } from '../../data/vocab-db';
import type { GlossaryEntry } from '../../domain/glossary';
import { newItem, todayISO } from '../../domain/review';
import { splitSenses } from '../../domain/sense';
import { formatTokenWithPunctuation } from '../../domain/sentence';
import { isTrusted } from '../../platform/core/classify';
import { recordClip } from '../../speech/record';
import {
  getPreferredAccent,
  setPreferredAccent,
  speakEnglish,
  speakSentence,
  stopSpeaking,
  type EnglishAccent,
} from '../../speech/speak';

interface WordCardProps {
  text: string;
  trusted: boolean;
  mode?: 'lookup' | 'review';
  accent?: EnglishAccent;
  onAccentChange?: (accent: EnglishAccent) => void;
  selectedWordId?: string | null;
  pageSentence?: OcrSentence | null;
  sentenceWords?: OcrWord[];
  savedContextSentence?: string;
  savedContextTranslation?: string;
  speakingWordIndex?: number | null;
  onSpeakingWordIndexChange?: (index: number | null) => void;
  onSelectWord?: (word: OcrWord) => void;
  onClose?: () => void;
}

const RECORD_SECONDS = 5;

export function WordCard({
  text,
  trusted,
  mode = 'lookup',
  accent: propAccent,
  onAccentChange,
  selectedWordId = null,
  pageSentence = null,
  sentenceWords = [],
  savedContextSentence,
  savedContextTranslation,
  speakingWordIndex = null,
  onSpeakingWordIndexChange,
  onSelectWord,
  onClose,
}: WordCardProps) {
  const [localAccent, setLocalAccent] = useState<EnglishAccent>(() => getPreferredAccent());
  const activeAccent = propAccent ?? localAccent;

  const chooseAccentAndSpeakWord = (nextAccent: EnglishAccent) => {
    setPreferredAccent(nextAccent);
    setLocalAccent(nextAccent);
    onAccentChange?.(nextAccent);
    onSpeakingWordIndexChange?.(null);
    speakEnglish(text, nextAccent);
  };
  const [sense, setSense] = useState<GlossaryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [remainingSec, setRemainingSec] = useState(RECORD_SECONDS);
  const [playingTake, setPlayingTake] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sentenceTrans, setSentenceTrans] = useState<SentenceTranslationResult | null>(null);
  const [sentenceLoading, setSentenceLoading] = useState(false);

  const clipRef = useRef<{ stop: () => void; done: Promise<Blob> } | null>(null);
  const countdownRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const discardRecordingRef = useRef(false);

  const activeSentenceText = pageSentence?.text ?? savedContextSentence ?? '';

  const clearRecordTimers = () => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = 0;
    }
  };

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    discardRecordingRef.current = false;
    setSaved(false);
    setTakeUrl(null);
    setNote(null);
    setSense(null);
    setLoading(true);
    setPlayingTake(false);

    void (async () => {
      const [item, take, next] = await Promise.all([
        getItem(text),
        getTake(text),
        trusted
          ? resolveSense(text)
              .then(async (entry) => {
                if (!cancelled) {
                  setSense(entry);
                  setLoading(false);
                }
                return enrichSense(entry);
              })
              .catch(() => ({
                word: text,
                meaning: `${text}（先听读音）`,
                example: `Let's read "${text}".`,
              }))
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (item) setSaved(true);
      if (take) {
        objectUrl = URL.createObjectURL(take);
        setTakeUrl(objectUrl);
      }
      if (next) setSense(next);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      discardRecordingRef.current = true;
      clearRecordTimers();
      clipRef.current?.stop();
      clipRef.current = null;
      audioRef.current?.pause();
      audioRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [text, trusted]);

  useEffect(() => {
    let cancelled = false;
    if (!activeSentenceText) {
      setSentenceTrans(null);
      setSentenceLoading(false);
      return;
    }

    if (savedContextTranslation) {
      setSentenceTrans({
        sentence: activeSentenceText,
        translation: savedContextTranslation,
        source: 'cached',
        breakdown: [],
      });
      setSentenceLoading(false);
      return;
    }

    void (async () => {
      const localRes = await resolveSentenceLocal(activeSentenceText);
      if (cancelled) return;
      setSentenceTrans(localRes);

      if (!localRes.translation) {
        setSentenceLoading(true);
        const aiText = await translateSentenceWithAi(activeSentenceText);
        if (cancelled) return;
        setSentenceLoading(false);
        if (aiText) {
          setSentenceTrans({
            ...localRes,
            translation: aiText,
            source: 'ai',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSentenceText, savedContextTranslation]);

  const save = async () => {
    await putItem(
      newItem(text, todayISO(), {
        sentence: activeSentenceText || undefined,
        translation: sentenceTrans?.translation ?? undefined,
      }),
    );
    setSaved(true);
  };

  const playRecordedUrl = (url: string) => {
    stopSpeaking();
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingTake(true);
    audio.addEventListener('ended', () => setPlayingTake(false));
    audio.addEventListener('error', () => setPlayingTake(false));
    void audio.play().catch(() => setPlayingTake(false));
  };

  const handleReadContextSentence = (slow: boolean, customAccent?: EnglishAccent) => {
    if (!activeSentenceText) return;
    const chosen = customAccent ?? activeAccent;
    if (customAccent) {
      setPreferredAccent(customAccent);
      setLocalAccent(customAccent);
      onAccentChange?.(customAccent);
    }
    audioRef.current?.pause();
    setPlayingTake(false);
    speakSentence(activeSentenceText, {
      accent: chosen,
      slow,
      onWordIndex: onSpeakingWordIndexChange,
    });
  };

  const toggleRecording = () => {
    if (recording) {
      clipRef.current?.stop();
      return;
    }

    stopSpeaking();
    audioRef.current?.pause();
    setPlayingTake(false);
    setNote(null);
    discardRecordingRef.current = false;

    const clip = recordClip(RECORD_SECONDS * 1000);
    clipRef.current = clip;
    setRecording(true);
    setRemainingSec(RECORD_SECONDS);

    clearRecordTimers();
    countdownRef.current = window.setInterval(() => {
      setRemainingSec((prev) => (prev > 1 ? prev - 1 : 1));
    }, 1000);

    void clip.done
      .then(async (blob) => {
        if (discardRecordingRef.current || blob.size === 0) return;
        await putTake(text, blob);
        const nextUrl = URL.createObjectURL(blob);
        setTakeUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return nextUrl;
        });
        playRecordedUrl(nextUrl);
      })
      .catch(() => {
        if (!discardRecordingRef.current) {
          setNote('请打开麦克风，再试着读一遍。');
        }
      })
      .finally(() => {
        clearRecordTimers();
        clipRef.current = null;
        if (!discardRecordingRef.current) {
          setRecording(false);
          setRemainingSec(RECORD_SECONDS);
        }
      });
  };

  if (!trusted) {
    return (
      <section className="word-card">
        <div className="word-card-header">
          <p className="word-card-text" lang="en">
            {text}
          </p>
        </div>
        <p className="word-card-meaning">这个先不读。</p>
      </section>
    );
  }

  const sentences = splitSenses(sense?.example ?? '');

  return (
    <section className="word-card">
      <div className="word-card-header">
        <div className="word-card-title-group">
          <p className="word-card-text" lang="en">
            {text}
          </p>
          {sense?.phonetic ? (
            <p className="word-card-phonetic">/{sense.phonetic.replace(/^\/|\/$/g, '')}/</p>
          ) : null}
        </div>
        <div className="word-card-header-actions">
          <button
            className={`kid-listen accent-btn${activeAccent === 'uk' ? ' is-active-accent' : ''}`}
            type="button"
            aria-pressed={activeAccent === 'uk'}
            onClick={() => chooseAccentAndSpeakWord('uk')}
          >
            🇬🇧 英音
          </button>
          <button
            className={`kid-listen accent-btn${activeAccent === 'us' ? ' is-active-accent' : ''}`}
            type="button"
            aria-pressed={activeAccent === 'us'}
            onClick={() => chooseAccentAndSpeakWord('us')}
          >
            🇺🇸 美音
          </button>
          {onClose ? (
            <button
              className="kid-card-dismiss"
              type="button"
              onClick={() => {
                stopSpeaking();
                onClose();
              }}
              aria-label="收起词卡"
            >
              好了
            </button>
          ) : null}
        </div>
      </div>

      <div className="word-sense-meaning-box">
        <span className="word-sense-badge">意思</span>
        <p className="word-card-meaning">{loading ? '正在找这个词…' : sense?.meaning}</p>
      </div>

      {activeSentenceText ? (
        <div className="context-sentence-box">
          <div className="context-sentence-head">
            <span className="context-sentence-badge">📖 书上这一句</span>
            <div className="context-sentence-btns">
              <button
                type="button"
                className="sentence-speak-btn"
                onClick={() => handleReadContextSentence(false, 'uk')}
              >
                🇬🇧 英音读句
              </button>
              <button
                type="button"
                className="sentence-speak-btn"
                onClick={() => handleReadContextSentence(false, 'us')}
              >
                🇺🇸 美音读句
              </button>
              <button
                type="button"
                className="sentence-speak-btn slow"
                onClick={() => handleReadContextSentence(true)}
              >
                🐢 慢读
              </button>
            </div>
          </div>

          <div className="context-sentence-words" lang="en">
            {sentenceWords.length > 0 ? (
              sentenceWords.map((word, idx) => {
                const { token } = formatTokenWithPunctuation(word);
                const isCurrent =
                  word.id === selectedWordId || word.text.toLowerCase() === text.toLowerCase();
                const isSpeaking = speakingWordIndex === idx;
                const canClick = isTrusted(word) && Boolean(onSelectWord);
                return (
                  <button
                    key={word.id}
                    type="button"
                    className={`sentence-token-btn${isCurrent ? ' is-target' : ''}${isSpeaking ? ' is-speaking' : ''}`}
                    disabled={!canClick}
                    onClick={() => {
                      if (canClick) onSelectWord?.(word);
                    }}
                  >
                    {token}
                  </button>
                );
              })
            ) : (
              <p className="context-sentence-plain">{activeSentenceText}</p>
            )}
          </div>

          {sentenceLoading ? (
            <p className="context-sentence-zh is-loading">正在翻译这一句…</p>
          ) : sentenceTrans?.translation ? (
            <p className="context-sentence-zh">{sentenceTrans.translation}</p>
          ) : sentenceTrans && sentenceTrans.breakdown.length > 0 ? (
            <div className="context-sentence-breakdown">
              {sentenceTrans.breakdown.map((item) => (
                <span key={item.word} className="breakdown-chip">
                  <strong lang="en">{item.word}</strong> {item.meaning}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="word-sense">
        <p className="word-sense-label">
          {activeSentenceText ? '更多例句（点句子听一听）' : '点句子听一听'}
        </p>
        {loading ? (
          <p className="word-card-example">正在准备例句…</p>
        ) : (
          <div className="example-list">
            {sentences.map((sentence) => (
              <button
                key={sentence}
                type="button"
                className="example-row"
                onClick={() => {
                  onSpeakingWordIndexChange?.(null);
                  speakEnglish(sentence, activeAccent);
                }}
              >
                <span className="example-icon" aria-hidden="true">
                  🔊
                </span>
                <span className="word-card-example" lang="en">
                  {sentence}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="word-card-actions">
        {mode === 'lookup' ? (
          <button
            type="button"
            className={`action-btn save-btn${saved ? ' is-saved' : ''}`}
            onClick={() => void save()}
            disabled={saved}
          >
            {saved ? '⭐ 已记下' : '☆ 记下来'}
          </button>
        ) : null}
        <button
          type="button"
          className={`action-btn record-btn${recording ? ' is-recording' : ''}`}
          onClick={toggleRecording}
        >
          {recording
            ? `⏹️ 读完点我 (${remainingSec}s)`
            : takeUrl
              ? '🎙️ 再读一次'
              : '🎙️ 我来读'}
        </button>
        <button
          type="button"
          className={`action-btn play-btn${playingTake ? ' is-playing' : ''}`}
          disabled={!takeUrl || recording}
          onClick={() => {
            if (!takeUrl) return;
            playRecordedUrl(takeUrl);
          }}
        >
          {playingTake ? '🔊 正在播…' : '🎧 听我读的'}
        </button>
      </div>
      {note ? <p className="footnote">{note}</p> : null}
    </section>
  );
}
