import { lemmaCandidates } from '../domain/lexicon';
import { lookupZhSense, type ZhDict, type ZhSense } from '../domain/sense';
import type { GlossaryEntry } from '../domain/glossary';

let cache: Promise<ZhDict | null> | null = null;

async function decodePayload(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return gzip
    ? await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
}

function parseDict(text: string): ZhDict {
  const raw = JSON.parse(text) as Record<string, string | [string, string] | [string, string, string]>;
  const dict: ZhDict = new Map();
  for (const [word, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      dict.set(word, value);
      continue;
    }
    const [phonetic, meaning, example] = value;
    dict.set(word, {
      phonetic: phonetic || undefined,
      meaning,
      example: example || '',
    });
  }
  return dict;
}

export function loadZhDict(): Promise<ZhDict | null> {
  cache ??= (async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller && typeof setTimeout === 'function'
        ? setTimeout(() => controller.abort(), 8000)
        : undefined;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}lexicon/zh-senses.json.gz`, {
        signal: controller?.signal,
      });
      if (!response.ok) {
        cache = null;
        return null;
      }
      return parseDict(await decodePayload(await response.arrayBuffer()));
    } catch {
      cache = null;
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  return cache;
}

export async function lookupZhDict(word: string): Promise<GlossaryEntry | null> {
  const dict = await loadZhDict();
  if (!dict) return null;
  const hit: ZhSense | null = lookupZhSense(dict, word, lemmaCandidates(word));
  if (!hit) return null;
  return {
    word,
    meaning: hit.meaning,
    example: hit.example,
    phonetic: hit.phonetic,
  };
}
