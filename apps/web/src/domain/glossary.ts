export interface GlossaryEntry {
  word: string;
  meaning: string;
  example: string;
  phonetic?: string;
}

/** 按识别出的词查释义。keys 可带词形还原后的原形，先精确再原形。 */
export function findGlossaryEntry(
  entries: readonly GlossaryEntry[],
  word: string,
  keys: readonly string[] = [],
): GlossaryEntry | null {
  const seen = new Set<string>();
  for (const raw of [word, ...keys]) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = entries.find((entry) => entry.word.toLowerCase() === key);
    if (hit) return hit;
  }
  return null;
}
