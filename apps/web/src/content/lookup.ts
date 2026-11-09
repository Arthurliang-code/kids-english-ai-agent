import { lookupGlossary } from './glossary';
import type { GlossaryEntry } from '../domain/glossary';

const memory = new Map<string, GlossaryEntry>();

function cacheKey(word: string): string {
  return `kea-sense:${word.toLowerCase()}`;
}

function readCache(word: string): GlossaryEntry | null {
  const hit = memory.get(word.toLowerCase());
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(cacheKey(word));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GlossaryEntry;
    if (typeof parsed.meaning !== 'string' || typeof parsed.example !== 'string') return null;
    memory.set(word.toLowerCase(), parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: GlossaryEntry): void {
  memory.set(entry.word.toLowerCase(), entry);
  try {
    localStorage.setItem(cacheKey(entry.word), JSON.stringify(entry));
  } catch {
    /* 存储满了也不影响当场显示 */
  }
}

function pickExample(payload: unknown, word: string): string {
  if (!Array.isArray(payload)) return `I can say "${word}".`;
  for (const entry of payload) {
    const meanings = (entry as { meanings?: { definitions?: { example?: string }[] }[] }).meanings;
    for (const meaning of meanings ?? []) {
      for (const definition of meaning.definitions ?? []) {
        if (definition.example && definition.example.length < 80) return definition.example;
      }
    }
  }
  return `I can say "${word}".`;
}

function pickPhonetic(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined;
  const first = payload[0] as { phonetic?: string; phonetics?: { text?: string }[] } | undefined;
  const text = first?.phonetic || first?.phonetics?.find((item) => item.text)?.text;
  return text || undefined;
}

async function fetchSense(word: string): Promise<GlossaryEntry> {
  const query = encodeURIComponent(word);
  const [zhPage, enPage] = await Promise.all([
    fetch(`https://api.mymemory.translated.net/get?q=${query}&langpair=en|zh-CN`).then((response) =>
      response.ok ? response.json() : null,
    ),
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${query}`).then((response) =>
      response.ok ? response.json() : null,
    ),
  ]);

  const translated = (zhPage as { responseData?: { translatedText?: string } } | null)?.responseData
    ?.translatedText;
  const meaning =
    translated && translated.toLowerCase() !== word.toLowerCase() ? translated : `${word}（英文单词）`;

  return {
    word,
    meaning,
    example: pickExample(enPage, word),
    phonetic: pickPhonetic(enPage),
  };
}

/** 先用家长写过的词卡，没有再用网上查到的解释，并记在本机。 */
export async function resolveSense(word: string): Promise<GlossaryEntry> {
  const local = lookupGlossary(word);
  if (local) return local;
  const cached = readCache(word);
  if (cached) return cached;
  const fetched = await fetchSense(word);
  writeCache(fetched);
  return fetched;
}
