let warmed = false;

function englishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.lang));
  return (
    english.find((voice) => /en-US/i.test(voice.lang) && /samantha|nicky|reed|allison|jenny/i.test(voice.name)) ??
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
  const trimmed = text.trim();
  if (!trimmed || !window.speechSynthesis) return;

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

export function stopSpeaking(): void {
  window.speechSynthesis.cancel();
}
