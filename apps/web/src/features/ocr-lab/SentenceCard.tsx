import { useEffect, useRef, useState } from 'react';
import type { OcrSentence, OcrWord } from '@kea/shared-types';
import {
  hasParentApiKey,
  resolveSentenceLocal,
  translateSentenceWithAi,
  type SentenceTranslationResult,
} from '../../content/translate';
import { getTake, putTake } from '../../data/vocab-db';
import { formatTokenWithPunctuation } from '../../domain/sentence';
import { isTrusted } from '../../platform/core/classify';
import { recordClip } from '../../speech/record';
import { speakEnglish, speakSentence, stopSpeaking } from '../../speech/speak';

interface SentenceCardProps {
  sentence: OcrSentence;
  sentenceWords: OcrWord[];
  speakingWordIndex: number | null;
  onSpeakingWordIndexChange: (index: number | null) => void;
  onSelectWord?: (word: OcrWord) => void;
  onClose?: () => void;
}

const SENTENCE_RECORD_SECONDS = 10;

export function SentenceCard({
  sentence,
  sentenceWords,
  speakingWordIndex,
  onSpeakingWordIndexChange,
  onSelectWord,
  onClose,
}: SentenceCardProps) {
  const [transResult, setTransResult] = useState<SentenceTranslationResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [remainingSec, setRemainingSec] = useState(SENTENCE_RECORD_SECONDS);
  const [playingTake, setPlayingTake] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const clipRef = useRef<{ stop: () => void; done: Promise<Blob> } | null>(null);
  const countdownRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const discardRecordingRef = useRef(false);

  const takeKey = `sentence:${sentence.text.toLowerCase()}`;

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
    setTransResult(null);
    setAiLoading(false);
    setTakeUrl(null);
    setNote(null);
    setPlayingTake(false);

    void (async () => {
      const [localRes, savedTake] = await Promise.all([
        resolveSentenceLocal(sentence.text),
        getTake(takeKey),
      ]);
      if (cancelled) return;

      setTransResult(localRes);
      if (savedTake) {
        objectUrl = URL.createObjectURL(savedTake);
        setTakeUrl(objectUrl);
      }

      if (!localRes.translation && hasParentApiKey()) {
        setAiLoading(true);
        const aiText = await translateSentenceWithAi(sentence.text);
        if (cancelled) return;
        setAiLoading(false);
        if (aiText) {
          setTransResult({
            ...localRes,
            translation: aiText,
            source: 'ai',
          });
        }
      }
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
  }, [sentence.text, takeKey]);

  const handleReadSentence = (slow: boolean) => {
    audioRef.current?.pause();
    setPlayingTake(false);
    speakSentence(sentence.text, {
      slow,
      onWordIndex: onSpeakingWordIndexChange,
    });
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

    const clip = recordClip(SENTENCE_RECORD_SECONDS * 1000);
    clipRef.current = clip;
    setRecording(true);
    setRemainingSec(SENTENCE_RECORD_SECONDS);

    clearRecordTimers();
    countdownRef.current = window.setInterval(() => {
      setRemainingSec((prev) => (prev > 1 ? prev - 1 : 1));
    }, 1000);

    void clip.done
      .then(async (blob) => {
        if (discardRecordingRef.current || blob.size === 0) return;
        await putTake(takeKey, blob);
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
          setRemainingSec(SENTENCE_RECORD_SECONDS);
        }
      });
  };

  return (
    <section className="word-card sentence-card">
      <div className="word-card-header">
        <span className="sentence-card-badge">📖 整句点读</span>
        <div className="word-card-header-actions">
          <button
            className="kid-listen"
            type="button"
            onClick={() => handleReadSentence(false)}
          >
            🔊 读整句
          </button>
          <button
            className="kid-listen slow"
            type="button"
            onClick={() => handleReadSentence(true)}
          >
            🐢 慢速读
          </button>
          {onClose ? (
            <button
              className="kid-card-dismiss"
              type="button"
              onClick={() => {
                stopSpeaking();
                onClose();
              }}
              aria-label="收起句子卡"
            >
              好了
            </button>
          ) : null}
        </div>
      </div>

      <div className="sentence-tokens-box" lang="en">
        {sentenceWords.length > 0 ? (
          sentenceWords.map((word, idx) => {
            const { token } = formatTokenWithPunctuation(word);
            const active = speakingWordIndex === idx;
            const canClick = isTrusted(word) && Boolean(onSelectWord);
            return (
              <button
                key={word.id}
                type="button"
                className={`sentence-token-btn${active ? ' is-speaking' : ''}`}
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
          <p className="sentence-plain-text">{sentence.text}</p>
        )}
      </div>

      <div className="word-sense-meaning-box sentence-translation-box">
        <span className="word-sense-badge">句意</span>
        {aiLoading ? (
          <p className="word-card-meaning is-loading">正在翻译整句…</p>
        ) : transResult?.translation ? (
          <p className="word-card-meaning">{transResult.translation}</p>
        ) : transResult && transResult.breakdown.length > 0 ? (
          <div className="sentence-breakdown-inline">
            <p className="sentence-breakdown-note">重点词义提示（点上方英文词可看详情）：</p>
            <div className="sentence-breakdown-chips">
              {transResult.breakdown.map((item) => (
                <span key={item.word} className="breakdown-chip">
                  <strong lang="en">{item.word}</strong> {item.meaning}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="word-card-meaning">点上方单词可逐个听读音、看解释</p>
        )}
      </div>

      {transResult?.translation && transResult.breakdown.length > 0 ? (
        <div className="word-sense">
          <p className="word-sense-label">👆 点句中重点词，听单词发音、看详解</p>
          <div className="sentence-word-strip">
            {transResult.breakdown.map((item) => {
              const matchedWord = sentenceWords.find(
                (w) => w.text.toLowerCase() === item.word.toLowerCase() && isTrusted(w),
              );
              return (
                <button
                  key={item.word}
                  type="button"
                  className="word-strip-chip"
                  onClick={() => {
                    if (matchedWord && onSelectWord) {
                      onSelectWord(matchedWord);
                    } else {
                      speakEnglish(item.word);
                    }
                  }}
                >
                  <span className="chip-en" lang="en">
                    {item.word}
                  </span>
                  <span className="chip-zh">{item.meaning}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="word-card-actions">
        <button
          type="button"
          className={`action-btn record-btn${recording ? ' is-recording' : ''}`}
          onClick={toggleRecording}
        >
          {recording
            ? `⏹️ 读完点我 (${remainingSec}s)`
            : takeUrl
              ? '🎙️ 再读整句'
              : '🎙️ 跟读整句'}
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
