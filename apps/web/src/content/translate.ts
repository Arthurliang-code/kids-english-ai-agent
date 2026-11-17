import { lookupGlossary } from './glossary';
import { loadZhDict } from './zh-dict';
import { lemmaCandidates } from '../domain/lexicon';
import { lookupZhSense, type ZhDict } from '../domain/sense';
import {
  buildSentenceWordBreakdown,
  matchExactSentence,
  matchHighConfidenceTemplate,
  normalizeSentenceKey,
  type WordGlossItem,
} from '../domain/sentence';

const API_KEY_STORAGE = 'kea.parent.deepseek_key';
const CACHE_STORAGE = 'kea.sentence.cache.v3';
const MAX_CACHE_ENTRIES = 600;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

const UNSAFE_ZH = /赌博|色情|暴力|自杀|毒品|脏话|杀害|mymemory|warning|quota/i;

/** 固定不变的精简 System Prompt：触发 DeepSeek 自动前缀缓存（输入成本再降 ~90%），无误时省略 en 字段省输出 token */
const BATCH_SYSTEM_PROMPT =
  '你是小学英语老师。核对并翻译OCR英文条目[["id","英文"]]。' +
  '规则：1.仅当英文有明显OCR错拼/乱码词/缺断字母时给出en(修正后英文，填空保持语义)；原句无误则省略en以省字数；' +
  '2.纯非英语乱码设drop:true并设zh:""；' +
  '3.译为自然地道适合小学生的简体中文zh。' +
  '只输出纯JSON：{"items":[{"id":"...","en":"可选","zh":"...","drop":false}]}';

const SINGLE_SYSTEM_PROMPT =
  '你是小学英语老师。核对并翻译这句OCR英文。若原句无误只回{"zh":"自然中文"}；' +
  '若有明显OCR错字/尾部乱码回{"en":"修正英文","zh":"自然中文"}；若纯乱码回{"drop":true,"zh":""}。只输出JSON。';

export type TranslationSource = 'template' | 'ai' | 'nmt' | 'draft' | 'breakdown';

export interface SentenceTranslationResult {
  sentence: string;
  /** 若大模型修复了 OCR 错别字/碎片，返回修正后的英文 */
  correctedEn?: string;
  /** 完整自然中文译文 */
  translation: string | null;
  source: TranslationSource;
  /** 若当前为草稿或待 AI 升级，为 true */
  needsAiUpgrade: boolean;
  /** 句中重点实词词义拆解 */
  breakdown: WordGlossItem[];
}

export interface PageBatchItemInput {
  id: string;
  text: string;
}

export interface PageBatchRefineResult {
  id: string;
  originalText: string;
  correctedEn?: string;
  zh?: string;
  drop?: boolean;
}

interface CachedEntry {
  zh: string;
  en?: string;
  src: 'ds' | 'nmt';
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

/** 验证 DeepSeek API Key 是否连通且可用（极简 1-token 探测） */
export async function testParentApiKey(
  candidateKey?: string,
): Promise<{ ok: boolean; message: string }> {
  const key = (candidateKey ?? getParentApiKey()).trim();
  if (!key) {
    return { ok: false, message: '请先填入 DeepSeek API Key。' };
  }
  if (!key.startsWith('sk-') || key.length < 20) {
    return { ok: false, message: '密钥格式看起来不对，DeepSeek Key 通常以 sk- 开头。' };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    if (resp.ok) {
      return { ok: true, message: '✅ 验证通过！已启用整页 OCR 纠错 + DeepSeek 精翻。' };
    }
    if (resp.status === 401) {
      return { ok: false, message: '❌ 密钥无效或已过期 (401)，请检查是否多空格或复制错误。' };
    }
    if (resp.status === 402) {
      return { ok: false, message: '❌ DeepSeek 账户余额不足 (402)，请充值后再试。' };
    }
    if (resp.status === 429) {
      return { ok: false, message: '⚠️ 请求过于频繁 (429)，密钥本身有效，请稍后再试。' };
    }
    return { ok: false, message: `❌ 接口返回异常状态 (${resp.status})。` };
  } catch {
    return { ok: false, message: '❌ 网络超时或无法连接到 api.deepseek.com，请检查网络。' };
  } finally {
    window.clearTimeout(timer);
  }
}

/* ---------- 本机持久化句子译文缓存 ---------- */

let memoryCache: Record<string, CachedEntry> | null = null;
let inFlightBatchPromise: Promise<PageBatchRefineResult[]> | null = null;

function readCache(): Record<string, CachedEntry> {
  if (memoryCache) return memoryCache;
  try {
    const raw = localStorage.getItem(CACHE_STORAGE);
    if (!raw) {
      memoryCache = {};
      return memoryCache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      memoryCache = parsed as Record<string, CachedEntry>;
      return memoryCache;
    }
  } catch {
    // 忽略损坏缓存
  }
  memoryCache = {};
  return memoryCache;
}

function writeCacheEntry(sentence: string, entry: CachedEntry): void {
  const key = normalizeSentenceKey(sentence);
  if (!key || !entry.zh) return;
  const store = readCache();
  // 若已有高质量 DeepSeek 缓存，不用免费 NMT 覆盖
  if (store[key]?.src === 'ds' && entry.src === 'nmt') return;

  store[key] = entry;
  // 若修正过英文，同时为修正后文本建立索引，防止重复扣 token
  if (entry.en) {
    const repairedKey = normalizeSentenceKey(entry.en);
    if (repairedKey && repairedKey !== key) {
      store[repairedKey] = { zh: entry.zh, src: entry.src };
    }
  }

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

export function getCachedEntry(sentence: string): CachedEntry | null {
  const key = normalizeSentenceKey(sentence);
  return readCache()[key] ?? null;
}

/* ---------- 安全清洗与校验 ---------- */

function sanitizeSentenceInput(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^A-Za-z0-9\s.,?!'"’‘“”\-;:()_]/g, '')
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

function validateRepairedEnglish(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 220) return undefined;
  if (!/[A-Za-z]{2,}/.test(cleaned)) return undefined;
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
 * 第一步：秒级本地解析。
 * - 若有 DeepSeek Key：仅“固定问候句”和“已是 DeepSeek 缓存”的句子直接定稿；
 *   本地通用规则或旧 NMT 缓存只作为加载瞬时的草稿，不会再阻断 DeepSeek！
 */
export async function resolveSentenceLocal(sentence: string): Promise<SentenceTranslationResult> {
  const dict = await loadZhDict();
  const lookupMeaning = createWordLookup(dict);
  const words = tokenizeSentenceWords(sentence);
  const breakdown = buildSentenceWordBreakdown(words, lookupMeaning);
  const hasKey = hasParentApiKey();

  const cached = getCachedEntry(sentence);
  if (cached) {
    if (cached.src === 'ds' || !hasKey) {
      return {
        sentence,
        correctedEn: cached.en,
        translation: cached.zh,
        source: cached.src === 'ds' ? 'ai' : 'nmt',
        needsAiUpgrade: false,
        breakdown,
      };
    }
    // 有 Key 但缓存里是旧的免费 NMT，先当作草稿展示并允许 DeepSeek 升级覆盖
    return {
      sentence,
      translation: cached.zh,
      source: 'draft',
      needsAiUpgrade: true,
      breakdown,
    };
  }

  const exact = matchExactSentence(sentence);
  if (exact) {
    return {
      sentence,
      translation: exact,
      source: 'template',
      needsAiUpgrade: false,
      breakdown,
    };
  }

  const fromRule = matchHighConfidenceTemplate(sentence, lookupMeaning);
  if (fromRule) {
    return {
      sentence,
      translation: fromRule,
      // 有 Key 时仅当临时草稿，继续放行给 DeepSeek 精翻（解决之前“规则截胡 AI”的问题）
      source: hasKey ? 'draft' : 'template',
      needsAiUpgrade: hasKey,
      breakdown,
    };
  }

  return {
    sentence,
    translation: null,
    source: 'breakdown',
    needsAiUpgrade: true,
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

/** DeepSeek 单句纠错 + 精翻 */
async function translateViaDeepSeek(
  safeInput: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ en?: string; zh: string } | null> {
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
        max_tokens: 140,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SINGLE_SYSTEM_PROMPT },
          { role: 'user', content: safeInput },
        ],
      }),
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const rawContent = (payload.choices?.[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    try {
      const parsed = JSON.parse(rawContent) as {
        en?: unknown;
        zh?: unknown;
        drop?: unknown;
      };
      if (parsed.drop === true) return null;
      const zh = typeof parsed.zh === 'string' ? validateChineseOutput(parsed.zh) : null;
      if (!zh) return null;
      return { en: validateRepairedEnglish(parsed.en), zh };
    } catch {
      const zh = validateChineseOutput(rawContent);
      return zh ? { zh } : null;
    }
  } catch {
    return null;
  }
}

/** 等待正在进行的整页批量精翻完成，避免同一句重复扣减 token */
export async function awaitInFlightBatch(): Promise<void> {
  if (inFlightBatchPromise) {
    await inFlightBatchPromise.catch(() => undefined);
  }
}

/**
 * 第二步：单句精翻升级（先等整页批处理完成，优先命中 DeepSeek 缓存，未命中再调 DeepSeek，失败兜底免费 NMT）
 */
export async function translateSentenceWithAi(
  sentence: string,
): Promise<{ zh: string; en?: string; source: 'ai' | 'nmt' } | null> {
  await awaitInFlightBatch();

  const hasKey = hasParentApiKey();
  const cached = getCachedEntry(sentence);
  if (cached && (cached.src === 'ds' || !hasKey)) {
    return { zh: cached.zh, en: cached.en, source: cached.src === 'ds' ? 'ai' : 'nmt' };
  }

  const safeInput = sanitizeSentenceInput(sentence);
  if (!safeInput) return null;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);

  try {
    const apiKey = getParentApiKey();
    if (apiKey) {
      const fromAi = await translateViaDeepSeek(safeInput, apiKey, controller.signal);
      if (fromAi) {
        writeCacheEntry(sentence, { zh: fromAi.zh, en: fromAi.en, src: 'ds' });
        return { zh: fromAi.zh, en: fromAi.en, source: 'ai' };
      }
    }

    if (cached) {
      return { zh: cached.zh, en: cached.en, source: 'nmt' };
    }

    const fromFreeNmt = await Promise.any([
      translateViaMyMemory(safeInput, controller.signal),
      translateViaGtx(safeInput, controller.signal),
    ]);
    if (fromFreeNmt) {
      writeCacheEntry(sentence, { zh: fromFreeNmt, src: 'nmt' });
      return { zh: fromFreeNmt, source: 'nmt' };
    }
    return null;
  } catch {
    return cached ? { zh: cached.zh, en: cached.en, source: 'nmt' } : null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 性价比核心：整页 1 次紧凑批处理完成「OCR 残句修复 + 乱码剔除 + 上下文精翻」。
 * - 跳过固定问候句（matchExactSentence）与已有 DeepSeek 缓存，绝不多花 1 个 token；
 * - 仅传 [["s0","..."]] 紧凑数组，且无误句省略 en 字段，单页仅约 250~500 token。
 */
export function pretranslatePageBatch(
  items: readonly PageBatchItemInput[],
): Promise<PageBatchRefineResult[]> {
  if (items.length === 0) return Promise.resolve([]);

  const apiKey = getParentApiKey();
  const pending: PageBatchItemInput[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const key = normalizeSentenceKey(item.text);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (matchExactSentence(item.text)) continue;
    const cached = getCachedEntry(item.text);
    if (cached && (cached.src === 'ds' || !apiKey)) continue;

    const safe = sanitizeSentenceInput(item.text);
    if (safe) pending.push({ id: item.id, text: safe });
    if (pending.length >= 16) break;
  }

  if (pending.length === 0) return Promise.resolve([]);

  if (!apiKey) {
    // 未配 Key 时并发预热前 5 条免配置翻译
    return Promise.allSettled(
      pending.slice(0, 5).map((item) => translateSentenceWithAi(item.text)),
    ).then(() => []);
  }

  const runPromise = (async (): Promise<PageBatchRefineResult[]> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 14000);

    try {
      const compactInput = pending.map((p) => [p.id, p.text]);
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
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: BATCH_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(compactInput) },
          ],
        }),
      });

      if (!response.ok) return [];
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = (payload.choices?.[0]?.message?.content ?? '')
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();

      const parsed = JSON.parse(content) as {
        items?: { id?: unknown; en?: unknown; zh?: unknown; drop?: unknown }[];
      };
      if (!Array.isArray(parsed.items)) return [];

      const byId = new Map(pending.map((p) => [p.id, p.text]));
      const results: PageBatchRefineResult[] = [];

      for (const rawItem of parsed.items) {
        if (typeof rawItem.id !== 'string') continue;
        const originalText = byId.get(rawItem.id);
        if (!originalText) continue;

        if (rawItem.drop === true) {
          results.push({ id: rawItem.id, originalText, drop: true });
          continue;
        }

        const zh = typeof rawItem.zh === 'string' ? validateChineseOutput(rawItem.zh) : null;
        const en = validateRepairedEnglish(rawItem.en);
        if (zh) {
          writeCacheEntry(originalText, { zh, en, src: 'ds' });
          results.push({ id: rawItem.id, originalText, correctedEn: en, zh });
        }
      }

      return results;
    } catch {
      return [];
    } finally {
      window.clearTimeout(timer);
    }
  })();

  inFlightBatchPromise = runPromise;
  void runPromise.finally(() => {
    if (inFlightBatchPromise === runPromise) {
      inFlightBatchPromise = null;
    }
  });
  return runPromise;
}
