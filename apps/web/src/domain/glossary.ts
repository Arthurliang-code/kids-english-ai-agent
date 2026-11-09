export interface GlossaryEntry {
  word: string;
  meaning: string;
  example: string;
  phonetic?: string;
}

/** 按识别出的词查家长写过的释义。大小写不敏感，不做词形还原。 */
export function findGlossaryEntry(
  entries: readonly GlossaryEntry[],
  word: string,
): GlossaryEntry | null {
  const key = word.toLowerCase();
  return entries.find((entry) => entry.word.toLowerCase() === key) ?? null;
}
