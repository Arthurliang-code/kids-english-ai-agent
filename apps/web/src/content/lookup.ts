import { lookupGlossary } from './glossary';
import { lookupZhDict } from './zh-dict';
import { mergeSenses } from '../domain/sense';
import type { GlossaryEntry } from '../domain/glossary';

async function fetchJson(url: string, ms = 2500): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function pickDictionaryExamples(payload: unknown, word: string): string[] {
  if (!Array.isArray(payload)) return [];
  const out: string[] = [];
  for (const entry of payload) {
    const meanings = (entry as { meanings?: { definitions?: { example?: string }[] }[] }).meanings;
    for (const meaning of meanings ?? []) {
      for (const definition of meaning.definitions ?? []) {
        const example = definition.example?.trim();
        if (!example || example.length < 8 || example.length > 80) continue;
        const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${safe}\\b`, 'i').test(example)) continue;
        if (out.includes(example)) continue;
        out.push(example.endsWith('.') ? example : `${example}.`);
        if (out.length === 2) return out;
      }
    }
  }
  return out;
}

/** 用词典例句补一层，失败就沿用已经有的解释。 */
export async function enrichSense(entry: GlossaryEntry): Promise<GlossaryEntry> {
  const payload = await fetchJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(entry.word)}`,
  );
  const extra = pickDictionaryExamples(payload, entry.word);
  if (!extra.length) return entry;
  return mergeSenses(entry.word, entry, {
    meaning: entry.meaning,
    example: extra.join('\n'),
    phonetic: entry.phonetic,
  });
}

/** 词卡优先，再叠 ECDICT 的义项和讲解。 */
export async function resolveSense(word: string): Promise<GlossaryEntry> {
  const local = lookupGlossary(word);
  const fromDict = await lookupZhDict(word);
  return mergeSenses(word, local, fromDict);
}
