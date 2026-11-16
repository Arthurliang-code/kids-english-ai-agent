export type EnglishAccent = 'uk' | 'us';

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

const ROBOTIC_OR_NOVELTY_VOICE =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|eddy|flo|fred|good news|grandma|grandpa|jester|junior|kathy|organ|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox|compact|espeak)\b/i;

const HIGH_QUALITY_TIER = /\b(natural|online|premium|enhanced|siri|neural)\b/i;

const UK_PREFERRED_NAMES =
  /\b(sonia|ryan|libby|maisie|daniel|serena|kate|oliver|martha|arthur|stephanie|jamie|google uk english)\b/i;

const US_PREFERRED_NAMES =
  /\b(aria|jenny|guy|ana|ava|allison|samantha|nicky|zoe|evan|noelle|tom|alex|google us english)\b/i;

function normalizeLang(lang: string): string {
  return lang.trim().replace(/_/g, '-').toLowerCase();
}

export function scoreEnglishVoice(voice: VoiceLike, accent: EnglishAccent): number {
  const lang = normalizeLang(voice.lang);
  if (!lang.startsWith('en')) return -1000;

  let score = 0;
  const targetLang = accent === 'uk' ? 'en-gb' : 'en-us';
  const secondaryLang = accent === 'uk' ? 'en-au' : 'en-ca';

  if (lang === targetLang || lang.startsWith(`${targetLang}-`)) {
    score += 120;
  } else if (lang === secondaryLang || lang.startsWith(`${secondaryLang}-`)) {
    score += 40;
  } else {
    score += 10;
  }

  if (ROBOTIC_OR_NOVELTY_VOICE.test(voice.name)) {
    score -= 300;
  }

  if (HIGH_QUALITY_TIER.test(voice.name)) {
    score += 90;
  }

  if (accent === 'uk' && UK_PREFERRED_NAMES.test(voice.name)) {
    score += 60;
  } else if (accent === 'us' && US_PREFERRED_NAMES.test(voice.name)) {
    score += 60;
  }

  if (voice.localService) {
    score += 5;
  }

  return score;
}

/**
 * 从浏览器提供的语音列表中，按口音（英式 en-GB / 美式 en-US）挑选最自然流畅的人声。
 * 自动避开 Reed / Fred / GrandPa / Bells 等合成搞怪音色。
 */
export function pickBestEnglishVoice<T extends VoiceLike>(
  voices: readonly T[],
  accent: EnglishAccent,
): T | null {
  const englishVoices = voices.filter((v) => normalizeLang(v.lang).startsWith('en'));
  if (englishVoices.length === 0) return null;

  let best: T | null = null;
  let bestScore = -Infinity;

  for (const voice of englishVoices) {
    const s = scoreEnglishVoice(voice, accent);
    if (s > bestScore) {
      bestScore = s;
      best = voice;
    }
  }

  return best;
}
