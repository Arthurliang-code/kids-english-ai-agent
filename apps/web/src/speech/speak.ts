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

function isSingleWord(text: string): boolean {
  return !/\s/.test(text.trim());
}

/**
 * 构建国内高可用流畅语音 URL 列表（按优先级排列）：
 * - 单词优先使用词典真人发音，失败自动切换至自然句读 TTS
 * - 完整句子直接使用实测 0.45~0.60s 稳定返回音频的自然连贯 TTS（规避单词接口对长句报 HTTP 500 的问题）
 */
function buildAudioCandidates(text: string, accent: EnglishAccent, slow: boolean): string[] {
  const encoded = encodeURIComponent(text);
  const baiduLang = accent === 'uk' ? 'uk' : 'en';
  const baiduSpeed = slow ? '2' : '3';
  const baiduUrl = `https://fanyi.baidu.com/gettts?lan=${baiduLang}&text=${encoded}&spd=${baiduSpeed}&source=web`;

  if (isSingleWord(text) && !slow) {
    const youdaoType = accent === 'uk' ? '1' : '2';
    const youdaoUrl = `https://dict.youdao.com/dictvoice?audio=${encoded}&type=${youdaoType}`;
    return [youdaoUrl, baiduUrl];
  }

  return [baiduUrl];
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
    const weight =
      Math.max(2, token.replace(/[^A-Za-z]/g, '').length) + (/[,.?!;:]/.test(token) ? 2 : 0);
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
  // 保持自然语速区间，避免过低语速引发 WebKit 语音撕裂与机械感
  utter.rate = slow ? 0.8 : 0.96;
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

    const msPerWeight = slow ? 85 : 64;
    let elapsed = 100;
    for (const span of spans) {
      const delay = elapsed;
      const timerId = window.setTimeout(() => {
        if (!finished && !boundaryFired) {
          onWordIndex(span.index);
        }
      }, delay);
      timers.push(timerId);
      elapsed += span.weight * msPerWeight + (slow ? 105 : 70);
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
 * 优先播放国内直连自然语音（英式 / 美式、单词 / 整句各自走最稳通道），
 * 若所有在线通道均不可用或设备离线，自动降级至本机优选自然人声。
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
  const candidates = buildAudioCandidates(trimmed, accent, slow);

  if (!audio || !isOnline || trimmed.length > 260 || candidates.length === 0) {
    speakWithSynthesis(trimmed, accent, slow, onWordIndex);
    return;
  }

  const spans = computeWordSpans(trimmed);
  const targetRate = slow ? 0.82 : 1.0;
  let candidateIdx = 0;
  let finished = false;
  let startedPlaying = false;
  let loadTimer = 0;

  const detach = () => {
    window.clearTimeout(loadTimer);
    audio.removeEventListener('playing', handlePlaying);
    audio.removeEventListener('timeupdate', handleTimeUpdate);
    audio.removeEventListener('ended', handleEnded);
    audio.removeEventListener('error', handleError);
  };

  const cleanupAudio = () => {
    if (finished) return;
    finished = true;
    detach();
    audio.pause();
    onWordIndex?.(null);
  };

  const tryNextOrSynthesis = () => {
    if (finished) return;
    window.clearTimeout(loadTimer);
    candidateIdx += 1;
    if (candidateIdx < candidates.length) {
      startedPlaying = false;
      startCandidate(candidates[candidateIdx]!);
      return;
    }
    cleanupAudio();
    speakWithSynthesis(trimmed, accent, slow, onWordIndex);
  };

  const handlePlaying = () => {
    startedPlaying = true;
    window.clearTimeout(loadTimer);
    audio.playbackRate = targetRate;
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
    tryNextOrSynthesis();
  };

  const startCandidate = (url: string) => {
    audio.pause();
    audio.src = url;
    audio.defaultPlaybackRate = targetRate;
    audio.playbackRate = targetRate;

    loadTimer = window.setTimeout(() => {
      if (!startedPlaying) {
        tryNextOrSynthesis();
      }
    }, 2400);

    void audio.play().catch(() => {
      tryNextOrSynthesis();
    });
  };

  activeCleanup = cleanupAudio;
  audio.addEventListener('playing', handlePlaying);
  audio.addEventListener('timeupdate', handleTimeUpdate);
  audio.addEventListener('ended', handleEnded);
  audio.addEventListener('error', handleError);

  startCandidate(candidates[0]!);
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
