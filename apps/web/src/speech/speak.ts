let warmed = false;
let activeCleanup: (() => void) | null = null;

function clearActiveListeners(): void {
  if (activeCleanup) {
    const fn = activeCleanup;
    activeCleanup = null;
    fn();
  }
}

function englishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.lang));
  return (
    english.find(
      (voice) =>
        /en-US/i.test(voice.lang) && /samantha|nicky|reed|allison|jenny/i.test(voice.name),
    ) ??
    english.find((voice) => /en-US/i.test(voice.lang)) ??
    english[0] ??
    null
  );
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

/**
 * 英文慢读。必须在点击的同一拍里调用：iPad 上 setTimeout / cancel 后再说，会没声音。
 */
export function speakEnglish(text: string): void {
  clearActiveListeners();
  const trimmed = text.trim();
  if (!trimmed || typeof window === 'undefined' || !window.speechSynthesis) return;

  const utter = new SpeechSynthesisUtterance(trimmed);
  utter.lang = 'en-US';
  utter.rate = 0.85;
  utter.pitch = 1;
  const voice = englishVoice();
  if (voice) utter.voice = voice;

  const synth = window.speechSynthesis;
  if (synth.speaking || synth.pending) synth.cancel();
  synth.speak(utter);
  if (synth.paused) synth.resume();
}

export interface SpeakSentenceOptions {
  slow?: boolean;
  onWordIndex?: (index: number | null) => void;
}

interface WordSpan {
  index: number;
  start: number;
  end: number;
  weight: number;
}

function computeWordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    spans.push({
      index: idx,
      start: match.index,
      end: match.index + token.length,
      weight: Math.max(2, token.length),
    });
    idx += 1;
  }
  return spans;
}

/**
 * 整句朗读（支持常速 / 慢速与逐词卡拉 OK 同步高亮）。
 * 同样在点击同一拍内同步调用 synth.speak(utter)，确保 iPad Safari 正常出声。
 */
export function speakSentence(text: string, options?: SpeakSentenceOptions): void {
  clearActiveListeners();
  const trimmed = text.trim();
  if (!trimmed || typeof window === 'undefined' || !window.speechSynthesis) return;

  const slow = Boolean(options?.slow);
  const onWordIndex = options?.onWordIndex;
  const spans = computeWordSpans(trimmed);

  const utter = new SpeechSynthesisUtterance(trimmed);
  utter.lang = 'en-US';
  utter.rate = slow ? 0.66 : 0.86;
  utter.pitch = 1;
  const voice = englishVoice();
  if (voice) utter.voice = voice;

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

    // 若部分语音不触发 onboundary，用按词长加权的计时器平滑回退
    const msPerChar = slow ? 95 : 70;
    let elapsed = 120;
    for (const span of spans) {
      const delay = elapsed;
      const timerId = window.setTimeout(() => {
        if (!finished && !boundaryFired) {
          onWordIndex(span.index);
        }
      }, delay);
      timers.push(timerId);
      elapsed += span.weight * msPerChar + (slow ? 130 : 85);
    }
  }

  utter.onend = () => cleanup();
  utter.onerror = () => cleanup();

  const synth = window.speechSynthesis;
  if (synth.speaking || synth.pending) synth.cancel();
  synth.speak(utter);
  if (synth.paused) synth.resume();
}

export function stopSpeaking(): void {
  clearActiveListeners();
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}
