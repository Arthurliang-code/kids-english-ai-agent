let token = 0;

/** 英文慢读。后一次调用会取消还没说完的上一次。 */
export function speakEnglish(text: string): void {
  const synth = window.speechSynthesis;
  const current = ++token;
  synth.cancel();
  window.setTimeout(() => {
    if (current !== token) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 0.8;
    const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith('en'));
    if (voice) utter.voice = voice;
    synth.speak(utter);
  }, 40);
}

export function stopSpeaking(): void {
  token += 1;
  window.speechSynthesis.cancel();
}
