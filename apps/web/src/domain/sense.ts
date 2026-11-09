const SKIP = ['[网络]', '[计算机]', '[医]', '[化学]', '[药]', '[法律]', '[金融]', '[俚语]', '[计]', '[口]', '[俚]'];
const POS = /^[a-zA-Z]{1,8}\.\s*/;
const JUNK = /家伙|复数|分词|过去式|\.\.\.|…|^当.+的/;

function usableLines(translation: string): string[] {
  return translation
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !SKIP.some((mark) => line.includes(mark)));
}

function piecesOf(line: string): string[] {
  const text = line.replace(POS, '').replace(/\[[^\]]*\]/g, '');
  const out: string[] = [];
  for (const chunk of text.split(/[；;]/)) {
    for (const piece of chunk.split(/[，,]/)) {
      const gloss = piece.replace(/[。．、\s]+/g, ' ').trim();
      if (gloss && /[\u4e00-\u9fff]/.test(gloss)) out.push(gloss);
    }
  }
  return out;
}

function glossesOf(line: string): string[] {
  const out: string[] = [];
  for (const gloss of piecesOf(line)) {
    if (gloss.length > 18 || JUNK.test(gloss)) continue;
    if (out.some((item) => gloss.startsWith(item) || item.startsWith(gloss))) continue;
    out.push(gloss);
  }
  return out;
}

/** 把词典里的多义项收成小朋友能看的一两句中文。 */
export function formatKidMeaning(translation: string): string {
  const lines = usableLines(translation);
  const picked: string[] = [];
  const limit = lines.length === 1 ? 1 : 2;
  for (const line of lines.slice(0, limit)) {
    const raw = piecesOf(line)[0];
    if (raw && JUNK.test(raw)) continue;
    const first = glossesOf(line)[0];
    if (!first || picked.includes(first)) continue;
    const head = picked[0];
    if (head && first.endsWith('的') && !head.endsWith('的')) continue;
    picked.push(first);
  }
  return picked.join('；');
}

export function formatKidExample(word: string, definition: string): string {
  const fallback = `This is ${word}.`;
  const line = usableLines(definition)[0];
  if (!line) return fallback;
  const text = line.replace(POS, '').replace(/\[[^\]]*\]/g, '').replace(/[。．]/g, '').trim();
  if (!text || text.length > 70 || !/[a-zA-Z]/.test(text)) return fallback;
  const display = word.charAt(0).toUpperCase() + word.slice(1);
  if (/^(a|an|the)\s/i.test(text)) return `${display} is ${text}.`;
  if (/^to\s/i.test(text)) {
    const rest = text.slice(3);
    if (!rest || /^be\s/i.test(rest)) return fallback;
    return `I ${rest}.`;
  }
  return `${display} means ${text}.`;
}

export type ZhSense = { meaning: string; phonetic?: string; example: string };
export type ZhDict = Map<string, ZhSense | string>;

export function lookupZhSense(dict: ZhDict, word: string, keys: readonly string[] = []): ZhSense | null {
  const seen = new Set<string>();
  for (const raw of [word, ...keys]) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let value: ZhSense | string | undefined = dict.get(key);
    if (typeof value === 'string') value = dict.get(value);
    if (value && typeof value !== 'string') return value;
  }
  return null;
}
