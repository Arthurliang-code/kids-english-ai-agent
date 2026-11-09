const SKIP = ['[网络]', '[计算机]', '[医]', '[化学]', '[药]', '[法律]', '[金融]', '[俚语]', '[计]', '[口]', '[俚]'];
const POS = /^[a-zA-Z]{1,8}\.\s*/;
const JUNK =
  /家伙|复数|分词|过去式|赌博|分队|部队|帐簿|名册|工作簿|神父|玩笑|游玩|跳动|假装|开玩笑|传摇曳|演戏|扮演|\.\.\.|…|^当.+的/;
const BAD_EN =
  /drama|theatrical|priest|church|trinity|\bgod\b|military|legal|medicine|vulgar|slang|computer|sexual|obsolete|baseball|binary compound|empedocles|mentally and emotionally|playing cards|card game|preset plan|feasible|organization regarded|eurasian|widely cultivated|distinguished position|letter of the|roman alphabet|hebrew alphabet|blood group|associate degree|united nations|possessive case|personal pronoun|cardinal number|objective case|definite article|auxiliary verb/i;
const NICE_EN =
  /\b(game|child|school|friend|family|fruit|water|book|home|play|happy|mother|father|together|run|read|like|parent|pages|company|liquid|joy|pleasure|foot)\b/i;

function usableLines(text: string): string[] {
  return text
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

function tooClose(picked: readonly string[], gloss: string): boolean {
  return picked.some((item) => gloss.startsWith(item) || item.startsWith(gloss));
}

function glossesOf(line: string): string[] {
  const out: string[] = [];
  for (const gloss of piecesOf(line)) {
    if (gloss.length > 18 || JUNK.test(gloss) || tooClose(out, gloss)) continue;
    out.push(gloss);
  }
  return out;
}

/** 词典多义项收成小朋友能读的几条中文。 */
export function formatKidMeaning(translation: string): string {
  const lines = usableLines(translation);
  const picked: string[] = [];
  for (const [index, line] of lines.slice(0, 3).entries()) {
    const raw = piecesOf(line)[0];
    if (raw && JUNK.test(raw)) continue;
    const cap = index === 0 ? 3 : 2;
    for (const gloss of glossesOf(line).slice(0, cap)) {
      if (tooClose(picked, gloss)) continue;
      picked.push(gloss);
      if (picked.length >= 4) return picked.join('；');
    }
  }
  return picked.join('；');
}

function shorten(text: string, max = 72): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const cut = Math.max(slice.lastIndexOf(','), slice.lastIndexOf(' '));
  return (cut > 30 ? slice.slice(0, cut) : slice).trim();
}

function toSentence(word: string, raw: string): string | null {
  const pos = /^(n|v|vt|vi|a|adj)\./i.exec(raw)?.[1]?.toLowerCase();
  const text = shorten(raw.replace(POS, '').replace(/\[[^\]]*\]/g, '').replace(/[。．]/g, '').trim());
  if (!text || text.length < 8 || !/[a-zA-Z]/.test(text)) return null;
  const display = word.charAt(0).toUpperCase() + word.slice(1);
  if (/^(a|an|the)\s/i.test(text)) return `${display} is ${text}.`;
  if (/^to\s/i.test(text)) {
    const rest = text.slice(3);
    if (!rest || /^be\s/i.test(rest)) return `${display} means ${text}.`;
    return `I ${rest}.`;
  }
  if (pos === 'n' || pos === 'a' || pos === 'adj') {
    const article = /^[aeiou]/i.test(text) ? 'an' : 'a';
    return `${display} is ${article} ${text}.`;
  }
  return `${display} means ${text}.`;
}

export function fallbackExample(word: string, meaning: string): string {
  const gloss = splitSenses(meaning).find((item) => /[\u4e00-\u9fff]/.test(item) && !item.includes('先听读音'));
  const display = word.charAt(0).toUpperCase() + word.slice(1);
  if (gloss) return `${display} means ${gloss}.`;
  return `Let's read "${word}".`;
}

function scoreEnglish(text: string): number {
  let score = 50 - Math.abs(text.length - 48) / 2;
  if (BAD_EN.test(text)) score -= 60;
  if (NICE_EN.test(text)) score += 18;
  if (/^(a|an|the|to)\s/i.test(text.replace(POS, ''))) score += 8;
  if (text.length > 90) score -= 12;
  return score;
}

/** 从词典英文释义里挑一两句适合小朋友的讲解。 */
export function formatKidExample(word: string, definition: string): string {
  return formatKidExamples(word, definition).join('\n');
}

export function formatKidExamples(word: string, definition: string): string[] {
  const ranked = usableLines(definition)
    .map((line) => ({ line, score: scoreEnglish(line) }))
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const item of ranked) {
    if (item.score < 0) continue;
    const sentence = toSentence(word, item.line);
    if (!sentence || out.includes(sentence)) continue;
    out.push(sentence);
    if (out.length === 2) break;
  }
  return out;
}

export function splitSenses(text: string): string[] {
  return text
    .split(/[；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isGenericExample(text: string): boolean {
  return /^This is \S+\.$/i.test(text.trim());
}

export function mergeSenses(
  word: string,
  primary: { meaning: string; example: string; phonetic?: string } | null,
  extra: { meaning: string; example: string; phonetic?: string } | null,
): { word: string; meaning: string; example: string; phonetic?: string } {
  const meanings: string[] = [];
  for (const gloss of [...splitSenses(primary?.meaning ?? ''), ...splitSenses(extra?.meaning ?? '')]) {
    if (meanings.some((item) => gloss === item || gloss.startsWith(item) || item.startsWith(gloss))) continue;
    if (gloss.includes('先听读音')) continue;
    meanings.push(gloss);
    if (meanings.length >= 4) break;
  }
  const examples: string[] = [];
  for (const sentence of [...splitSenses(primary?.example ?? ''), ...splitSenses(extra?.example ?? '')]) {
    if (isGenericExample(sentence) || examples.includes(sentence)) continue;
    examples.push(sentence);
    if (examples.length >= 2) break;
  }
  return {
    word,
    meaning: meanings.join('；') || `${word}（先听读音）`,
    example: examples.join('\n') || fallbackExample(word, meanings.join('；')),
    phonetic: primary?.phonetic || extra?.phonetic,
  };
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
