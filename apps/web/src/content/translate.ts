import { lookupGlossary } from './glossary';
import { loadZhDict } from './zh-dict';
import { lemmaCandidates } from '../domain/lexicon';
import { lookupZhSense, type ZhDict } from '../domain/sense';
import {
  buildSentenceWordBreakdown,
  matchHighConfidenceTemplate,
  normalizeSentenceKey,
  type WordGlossItem,
} from '../domain/sentence';

const API_KEY_STORAGE = 'kea.parent.deepseek_key';
const CACHE_STORAGE = 'kea.sentence.cache.v2';
const MAX_CACHE_ENTRIES = 500;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

const UNSAFE_ZH = /赌博|色情|暴力|自杀|毒品|脏话|杀害|mymemory|warning|quota/i;

export type TranslationSource = 'template' | 'ai' | 'cached' | 'breakdown';

export interface SentenceTranslationResult {
  sentence: string;
  /** 完整自然中文译文 */
  translation: string | null;
  source: TranslationSource;
  /** 句中重点实词词义拆解 */
  breakdown: WordGlossItem[];
}

/* ---------- 家长本机 API Key 管理 ---------- */

export function getParentApiKey(): string {
  try {
    return (localStorage.getItem(API_KEY_STORAGE) ?? '').trim();
  } catch {
    return '';
  }
}

export function setParentApiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) {
      localStorage.setItem(API_KEY_STORAGE, trimmed);
    } else {
      localStorage.removeItem(API_KEY_STORAGE);
    }
  } catch {
    // 忽略隐私模式写入限制
  }
}

export function hasParentApiKey(): boolean {
  return getParentApiKey().length > 0;
}

/* ---------- 本机持久化句子译文缓存 ---------- */

let memoryCache: Record<string, string> | null = null;

function readCache(): Record<string, string> {
  if (memoryCache) return memoryCache;
  try {
    const raw = localStorage.getItem(CACHE_STORAGE);
    if (!raw) {
      memoryCache = {};
      return memoryCache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      memoryCache = parsed as Record<string, string>;
      return memoryCache;
    }
  } catch {
    // 忽略损坏缓存
  }
  memoryCache = {};
  return memoryCache;
}

function writeCacheEntry(sentence: string, translation: string): void {
  const key = normalizeSentenceKey(sentence);
  if (!key || !translation) return;
  const store = readCache();
  store[key] = translation;

  const keys = Object.keys(store);
  if (keys.length > MAX_CACHE_ENTRIES) {
    for (const oldKey of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) {
      delete store[oldKey];
    }
  }

  try {
    localStorage.setItem(CACHE_STORAGE, JSON.stringify(store));
  } catch {
    // 忽略配额限制
  }
}

export function getCachedTranslation(sentence: string): string | null {
  const key = normalizeSentenceKey(sentence);
  return readCache()[key] ?? null;
}

/* ---------- 安全清洗与校验 ---------- */

function sanitizeSentenceInput(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^A-Za-z0-9\s.,?!'"’‘“”\-;:()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 2 || cleaned.length > 220) return null;
  if (!/[A-Za-z]{2,}/.test(cleaned)) return null;
  return cleaned;
}

function validateChineseOutput(raw: string): string | null {
  const cleaned = raw
    .replace(/^["'“”‘’《》【】\s]+|["'“”‘’《》【】\s]+$/g, '')
    .replace(/^(译文|翻译|中文)[:：]\s*/, '')
    .trim();

  if (!cleaned || cleaned.length > 140) return null;
  if (!/[\u4e00-\u9fff]/.test(cleaned)) return null;
  if (UNSAFE_ZH.test(cleaned)) return null;
  return cleaned;
}

/* ---------- 词典辅助查找 ---------- */

function createWordLookup(dict: ZhDict | null): (word: string) => string | null {
  return (word: string) => {
    const local = lookupGlossary(word);
    if (local?.meaning) return local.meaning;
    if (!dict) return null;
    const hit = lookupZhSense(dict, word, lemmaCandidates(word));
    return hit?.meaning ?? null;
  };
}

function tokenizeSentenceWords(sentence: string): string[] {
  return sentence
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, ''))
    .filter(Boolean);
}

/**
 * 第一步：纯本机秒级解析（查缓存 -> 查本地整句语法与句型引擎 -> 提取重点词）
 */
export async function resolveSentenceLocal(sentence: string): Promise<SentenceTranslationResult> {
  const dict = await loadZhDict();
  const lookupMeaning = createWordLookup(dict);
  const words = tokenizeSentenceWords(sentence);
  const breakdown = buildSentenceWordBreakdown(words, lookupMeaning);

  const cached = getCachedTranslation(sentence);
  if (cached) {
    return {
      sentence,
      translation: cached,
      source: 'cached',
      breakdown,
    };
  }

  const fromTemplate = matchHighConfidenceTemplate(sentence, lookupMeaning);
  if (fromTemplate) {
    return {
      sentence,
      translation: fromTemplate,
      source: 'template',
      breakdown,
    };
  }

  return {
    sentence,
    translation: null,
    source: 'breakdown',
    breakdown,
  };
}

/** 免配置在线神经网络翻译通道 A：MyMemory NMT */
async function translateViaMyMemory(safeInput: string, signal: AbortSignal): Promise<string> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(safeInput)}&langpair=en|zh-CN`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error('MyMemory HTTP error');
  const data = (await resp.json()) as {
    responseStatus?: number;
    responseData?: { translatedText?: string };
  };
  const valid = validateChineseOutput(data.responseData?.translatedText ?? '');
  if (!valid) throw new Error('Invalid MyMemory output');
  return valid;
}

/** 免配置在线神经网络翻译通道 B：Google GTX NMT */
async function translateViaGtx(safeInput: string, signal: AbortSignal): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(safeInput)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error('GTX HTTP error');
  const data = (await resp.json()) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Unexpected GTX payload');
  }
  const joined = (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('');
  const valid = validateChineseOutput(joined);
  if (!valid) throw new Error('Invalid GTX output');
  return valid;
}

/** DeepSeek 大模型语境翻译（配置了本机 API Key 时优先使用） */
async function translateViaDeepSeek(
  safeInput: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.1,
        max_tokens: 120,
        messages: [
          {
            role: 'system',
            content:
              '你是一位中国小学英语老师。请将用户给出的英文课本句子翻译成自然、准确、适合小学生理解的简体中文。只输出中文译文，不要解释，不要加引号。',
          },
          {
            role: 'user',
            content: safeInput,
          },
        ],
      }),
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const rawContent = payload.choices?.[0]?.message?.content ?? '';
    return validateChineseOutput(rawContent);
  } catch {
    return null;
  }
}

/**
 * 第二步：整句在线神经网络翻译（优先使用 DeepSeek Key，未配置 Key 时自动走免配置双路神经网络翻译竞速）
 */
export async function translateSentenceWithAi(sentence: string): Promise<string | null> {
  const cached = getCachedTranslation(sentence);
  if (cached) return cached;

  const safeInput = sanitizeSentenceInput(sentence);
  if (!safeInput) return null;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6500);

  try {
    const apiKey = getParentApiKey();
    if (apiKey) {
      const fromAi = await translateViaDeepSeek(safeInput, apiKey, controller.signal);
      if (fromAi) {
        writeCacheEntry(sentence, fromAi);
        return fromAi;
      }
    }

    const fromFreeNmt = await Promise.any([
      translateViaMyMemory(safeInput, controller.signal),
      translateViaGtx(safeInput, controller.signal),
    ]);
    if (fromFreeNmt) {
      writeCacheEntry(sentence, fromFreeNmt);
      return fromFreeNmt;
    }
    return null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 整页批量预翻译：拍完一页后，把本页未命中本地语法的句子提前译好写入缓存。
 */
export async function pretranslatePageSentences(sentences: readonly string[]): Promise<void> {
  if (sentences.length === 0) return;

  const dict = await loadZhDict();
  const lookupMeaning = createWordLookup(dict);

  const pending: string[] = [];
  const seen = new Set<string>();

  for (const raw of sentences) {
    const key = normalizeSentenceKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (getCachedTranslation(raw)) continue;
    if (matchHighConfidenceTemplate(raw, lookupMeaning)) continue;

    const safe = sanitizeSentenceInput(raw);
    if (safe) pending.push(safe);
    if (pending.length >= 10) break;
  }

  if (pending.length === 0) return;

  const apiKey = getParentApiKey();
  if (!apiKey) {
    // 未配 Key 时并发预热前 5 条免配置神经翻译
    await Promise.allSettled(pending.slice(0, 5).map((item) => translateSentenceWithAi(item)));
    return;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.1,
        max_tokens: 600,
        messages: [
          {
            role: 'system',
            content:
              '你是一位中国小学英语老师。请将输入的 JSON 英文句子数组逐条翻译成自然、准确、适合小学生的简体中文。严格只输出 JSON 数组格式（例如 ["译文1", "译文2"]），数组长度必须与输入完全一致。',
          },
          {
            role: 'user',
            content: JSON.stringify(pending),
          },
        ],
      }),
    });

    if (!response.ok) return;
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = (payload.choices?.[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return;

    for (let i = 0; i < pending.length; i += 1) {
      const item = parsed[i];
      if (typeof item === 'string') {
        const valid = validateChineseOutput(item);
        if (valid) writeCacheEntry(pending[i]!, valid);
      }
    }
  } catch {
    // 后台预热静默失败，不影响点读
  } finally {
    window.clearTimeout(timer);
  }
}
