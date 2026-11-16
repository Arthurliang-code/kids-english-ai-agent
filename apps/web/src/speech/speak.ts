import { pickBestEnglishVoice, type EnglishAccent } from '../domain/voice';

export type { EnglishAccent };

const ACCENT_STORAGE_KEY = 'kea.speech.accent';
let warmed = false;
let activeCleanup: (() => void) | null = null;
let sharedAudio: HTMLAudioElement | null = null;

export function getPreferredAccent(): EnglishAccent {
  try {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (saved === 'uk' || saved === 'us') return saved;
  } catch {
    // 忽略读取异常
  }
  return 'uk';
}

export function setPreferredAccent(accent: EnglishAccent): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // 忽略写入异常
  }
}

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = 'auto';
  }
  return sharedAudio;
}

function clearActiveListeners(): void {
  if (activeCleanup) {
    const fn = activeCleanup;
    activeCleanup = null;
    fn();
  }
}

function selectSystemVoice(accent: EnglishAccent): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  return pickBestEnglishVoice(voices, accent);
}

/** 提前把系统英文语音列表拉出来，点词时才选得到。 */
export function warmVoices(): void {
  if (warmed || typeof window === 'undefined' || !window.speechSynthesis) return;
  warmed = true;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}

function buildDictVoiceUrl(text: string, accent: EnglishAccent): string {
  const type = accent === 'uk' ? '1' : '2';
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${type}`;
}

interface WordSpan {
  index: number;
  start: number;
  end: number;
  weight: number;
  cumStartRatio: number;
  cumEndRatio: number;
}

function computeWordSpans(text: string): WordSpan[] {
  const raw: { index: number; start: number; end: number; weight: number }[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  let totalWeight = 0;

  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    const weight = Math.max(2, token.replace(/[^A-Za-z]/g, '').length) + (/[,.?!;:]/.test(token) ? 2 : 0);
    raw.push({
      index: idx,
      start: match.index,
      end: match.index + token.length,
      weight,
    });
    totalWeight += weight;
    idx += 1;
  }

  let acc = 0;
  return raw.map((item) => {
    const cumStartRatio = totalWeight > 0 ? acc / totalWeight : 0;
    acc += item.weight;
    const cumEndRatio = totalWeight > 0 ? acc / totalWeight : 1;
    return { ...item, cumStartRatio, cumEndRatio };
  });
}

function speakWithSynthesis(
  text: string,
  accent: EnglishAccent,
  slow: boolean,
  onWordIndex?: (index: number | null) => void,
): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onWordIndex?.(null);
    return;
  }

  const spans = computeWordSpans(text);
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = accent === 'uk' ? 'en-GB' : 'en-US';
  // 0.92 常速与 0.74 慢速可避免 WebKit 过度变速带来的机械电音感
  utter.rate = slow ? 0.74 : 0.92;
  utter.pitch = 1;

  const voice = selectSystemVoice(accent);
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }

  let finished = false;
  let boundaryFired = false;
  const timers: number[] = [];

  const cleanup = () => {
    if (finished) return;
    finished = true;
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    onWordIndex?.(null);
  };

  activeCleanup = cleanup;

  if (onWordIndex && spans.length > 0) {
    onWordIndex(0);

    utter.onboundary = (event: SpeechSynthesisEvent) => {
      if (finished) return;
      if (typeof event.charIndex === 'number') {
        boundaryFired = true;
        const charIdx = event.charIndex;
        const found =
          spans.find((s) => charIdx >= s.start && charIdx < s.end) ??
          spans.find((s) => s.start >= charIdx);
        if (found) onWordIndex(found.index);
      }
    };

    const msPerWeight = slow ? 88 : 66;
    let elapsed = 100;
    for (const span of spans) {
      const delay = elapsed;
      const timerId = window.setTimeout(() => {
        if (!finished && !boundaryFired) {
          onWordIndex(span.index);
        }
      }, delay);
      timers.push(timerId);
      elapsed += span.weight * msPerWeight + (slow ? 110 : 75);
    }
  }

  utter.onend = () => cleanup();
  utter.onerror = () => cleanup();

  const synth = window.speechSynthesis;
  if (synth.speaking || synth.pending) synth.cancel();
  synth.speak(utter);
  if (synth.paused) synth.resume();
}

/**
 * 优先使用国内直连真人/神经网络语音（支持纯正英音 type=1 / 美音 type=2），
 * 离线或加载超时（1.4s）时自动无缝降级到本机优选的高品质系统语音。
 */
function playFluentAudioOrFallback(
  text: string,
  accent: EnglishAccent,
  slow: boolean,
  onWordIndex?: (index: number | null) => void,
): void {
  clearActiveListeners();
  const trimmed = text.trim();
  if (!trimmed) return;

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
  }

  const audio = getSharedAudio();
  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

  if (!audio || !isOnline || trimmed.length > 240) {
    speakWithSynthesis(trimmed, accent, slow, onWordIndex);
    return;
  }

  const spans = computeWordSpans(trimmed);
  let finished = false;
  let startedPlaying = false;

  const cleanupAudio = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(loadTimer);
    audio.removeEventListener('playing', handlePlaying);
    audio.removeEventListener('timeupdate', handleTimeUpdate);
    audio.removeEventListener('ended', handleEnded);
    audio.removeEventListener('error', handleError);
    audio.pause();
    onWordIndex?.(null);
  };

  const fallbackToSynthesis = () => {
    if (finished) return;
    cleanupAudio();
    speakWithSynthesis(trimmed, accent, slow, onWordIndex);
  };

  const handlePlaying = () => {
    startedPlaying = true;
    window.clearTimeout(loadTimer);
    if (onWordIndex && spans.length > 0) {
      onWordIndex(0);
    }
  };

  const handleTimeUpdate = () => {
    if (finished || !onWordIndex || spans.length === 0) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const ratio = Math.max(0, Math.min(0.999, audio.currentTime / duration));
    const currentSpan =
      spans.find((s) => ratio >= s.cumStartRatio && ratio < s.cumEndRatio) ??
      spans[spans.length - 1];
    if (currentSpan) {
      onWordIndex(currentSpan.index);
    }
  };

  const handleEnded = () => {
    cleanupAudio();
  };

  const handleError = () => {
    fallbackToSynthesis();
  };

  activeCleanup = cleanupAudio;

  audio.pause();
  audio.src = buildDictVoiceUrl(trimmed, accent);
  audio.playbackRate = slow ? 0.78 : 1.0;

  audio.addEventListener('playing', handlePlaying);
  audio.addEventListener('timeupdate', handleTimeUpdate);
  audio.addEventListener('ended', handleEnded);
  audio.addEventListener('error', handleError);

  const loadTimer = window.setTimeout(() => {
    if (!startedPlaying) {
      fallbackToSynthesis();
    }
  }, 1400);

  void audio.play().catch(() => {
    fallbackToSynthesis();
  });
}

/**
 * 单词与短句发音（默认使用用户当前选择的英音/美音，也可显式传入 accent 对比听）。
 */
export function speakEnglish(text: string, accent?: EnglishAccent): void {
  const chosenAccent = accent ?? getPreferredAccent();
  playFluentAudioOrFallback(text, chosenAccent, false);
}

export interface SpeakSentenceOptions {
  accent?: EnglishAccent;
  slow?: boolean;
  onWordIndex?: (index: number | null) => void;
}

/**
 * 整句朗读（支持英式/美式、常速/慢速与逐词卡拉 OK 同步高亮）。
 */
export function speakSentence(text: string, options?: SpeakSentenceOptions): void {
  const chosenAccent = options?.accent ?? getPreferredAccent();
  const slow = Boolean(options?.slow);
  playFluentAudioOrFallback(text, chosenAccent, slow, options?.onWordIndex);
}

export function stopSpeaking(): void {
  clearActiveListeners();
  if (sharedAudio) {
    sharedAudio.pause();
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}
