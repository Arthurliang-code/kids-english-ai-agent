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
const CACHE_STORAGE = 'kea.sentence.cache.v1';
const MAX_CACHE_ENTRIES = 400;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

const UNSAFE_ZH = /赌博|色情|暴力|自杀|毒品|脏话|杀害/;

export type TranslationSource = 'template' | 'ai' | 'cached' | 'breakdown';

export interface SentenceTranslationResult {
  sentence: string;
  /** 完整自然中文译文；若未配置密钥且未命中固定句型则为 null，绝不乱拼误导 */
  translation: string | null;
  source: TranslationSource;
  /** 句中重点实词词义拆解（始终提供，供精读与离线辅助） */
  breakdown: WordGlossItem[];
}

/* ---------- 家长本机 API Key 管理（仅保存在本台 iPad localStorage，绝不进代码库） ---------- */

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

/* ---------- 安全清洗与校验（防 Prompt 注入与异常输出） ---------- */

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
 * 第一步：纯本机秒级解析（查缓存 -> 查高置信小学句型 -> 生成重点词拆解）
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

/**
 * 第二步：当本机配置了 DeepSeek API Key 时，调用大模型做语境精准翻译并永久缓存
 */
export async function translateSentenceWithAi(sentence: string): Promise<string | null> {
  const cached = getCachedTranslation(sentence);
  if (cached) return cached;

  const safeInput = sanitizeSentenceInput(sentence);
  if (!safeInput) return null;

  const apiKey = getParentApiKey();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);

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
    const valid = validateChineseOutput(rawContent);
    if (valid) {
      writeCacheEntry(sentence, valid);
    }
    return valid;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 整页批量预翻译：拍完一页后，若已配 API Key，一次请求把本页未缓存的可信句子全部译好写入缓存。
 * 孩子随后点任何词或句子都是 0 毫秒秒出。
 */
export async function pretranslatePageSentences(sentences: readonly string[]): Promise<void> {
  const apiKey = getParentApiKey();
  if (!apiKey || sentences.length === 0) return;

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
    if (pending.length >= 12) break;
  }

  if (pending.length === 0) return;

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
