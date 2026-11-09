import { lookupGlossary } from './glossary';
import { lookupZhDict } from './zh-dict';
import type { GlossaryEntry } from '../domain/glossary';

/** 先用家长词卡，再用 ECDICT 英汉词典。不再使用在线翻译。 */
export async function resolveSense(word: string): Promise<GlossaryEntry> {
  const local = lookupGlossary(word);
  if (local) return local;
  const fromDict = await lookupZhDict(word);
  if (fromDict) return fromDict;
  return {
    word,
    meaning: `${word}（先听读音）`,
    example: `This is ${word}.`,
  };
}
