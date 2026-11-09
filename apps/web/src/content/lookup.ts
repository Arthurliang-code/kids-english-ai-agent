import { lookupGlossary } from './glossary';
import { lookupZhDict } from './zh-dict';
import { formatKidExample, mergeSenses } from '../domain/sense';
import { lemmaCandidates } from '../domain/lexicon';
import type { GlossaryEntry } from '../domain/glossary';

async function fetchJson(url: string, ms = 5000): Promise<unknown> {
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
  const sentences: string[] = [];
  const glosses: string[] = [];
  const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasWord = new RegExp(`\\b${safe}\\b`, 'i');
  for (const entry of payload) {
    const meanings = (entry as { meanings?: { definitions?: { definition?: string; example?: string }[] }[] })
      .meanings;
    for (const meaning of meanings ?? []) {
      for (const definition of meaning.definitions ?? []) {
        const example = definition.example?.trim();
        if (example && example.length >= 8 && example.length <= 90) {
          const sentence = example.endsWith('.') ? example : `${example}.`;
          if (hasWord.test(sentence)) sentences.unshift(sentence);
          else if (!sentences.includes(sentence)) sentences.push(sentence);
        }
        if (definition.definition) glosses.push(definition.definition);
      }
    }
  }
  const out = [...new Set(sentences)].slice(0, 2);
  if (out.length >= 2) return out;
  const fromGloss = formatKidExample(word, glosses.map((item) => `n. ${item}`).join('\n'));
  for (const sentence of fromGloss.split('\n')) {
    if (sentence && !out.includes(sentence)) out.push(sentence);
    if (out.length >= 2) break;
  }
  return out;
}

async function fetchDictionary(word: string): Promise<unknown> {
  return fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
}

/** 用词典例句补一层，失败就沿用已经有的解释。 */
export async function enrichSense(entry: GlossaryEntry): Promise<GlossaryEntry> {
  const queries = [...new Set([entry.word, ...lemmaCandidates(entry.word)])].slice(0, 2);
  let extra: string[] = [];
  for (const query of queries) {
    extra = pickDictionaryExamples(await fetchDictionary(query), query);
    if (extra.length) break;
  }
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
