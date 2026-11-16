/** 技术设计 5.8：stage 0–5，间隔按新阶段取值。 */
export const REVIEW_INTERVALS_DAYS = [0, 1, 3, 7, 16, 35] as const;
export const DAILY_REVIEW_LIMIT = 20;

export interface ReviewItem {
  word: string;
  stage: number;
  due: string;
  /** 记单词时所在的课本原句 */
  contextSentence?: string;
  /** 课本原句对应的中文翻译 */
  contextTranslation?: string;
}

export interface ReviewContext {
  sentence?: string;
  translation?: string;
}

export interface VocabFile {
  version: 1;
  items: ReviewItem[];
}

export function todayISO(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map((part) => Number(part));
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + days);
  return todayISO(date);
}

export function newItem(word: string, today: string, context?: ReviewContext): ReviewItem {
  const item: ReviewItem = { word: word.toLowerCase(), stage: 0, due: today };
  const sentence = context?.sentence?.trim();
  const translation = context?.translation?.trim();
  if (sentence) item.contextSentence = sentence;
  if (translation) item.contextTranslation = translation;
  return item;
}

function clampStage(stage: number): number {
  return Math.max(0, Math.min(REVIEW_INTERVALS_DAYS.length - 1, stage));
}

export function grade(item: ReviewItem, correct: boolean, today: string): ReviewItem {
  const stage = clampStage(correct ? item.stage + 1 : item.stage - 1);
  const interval = REVIEW_INTERVALS_DAYS[stage] ?? 0;
  const next: ReviewItem = { word: item.word, stage, due: addDays(today, interval) };
  if (item.contextSentence) next.contextSentence = item.contextSentence;
  if (item.contextTranslation) next.contextTranslation = item.contextTranslation;
  return next;
}

export function dueItems(
  items: readonly ReviewItem[],
  today: string,
  limit = DAILY_REVIEW_LIMIT,
): ReviewItem[] {
  return items
    .filter((item) => item.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage)
    .slice(0, limit);
}

const DUE = /^\d{4}-\d{2}-\d{2}$/;

export function parseVocabExport(value: unknown): ReviewItem[] | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as { version?: unknown; items?: unknown };
  if (file.version !== 1 || !Array.isArray(file.items)) return null;

  const items: ReviewItem[] = [];
  for (const raw of file.items) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as {
      word?: unknown;
      stage?: unknown;
      due?: unknown;
      contextSentence?: unknown;
      contextTranslation?: unknown;
    };
    if (typeof item.word !== 'string' || !/^[a-z][a-z'’-]*$/i.test(item.word)) return null;
    if (typeof item.stage !== 'number' || !Number.isInteger(item.stage)) return null;
    if (item.stage < 0 || item.stage > 5) return null;
    if (typeof item.due !== 'string' || !DUE.test(item.due)) return null;
    const parsedItem: ReviewItem = {
      word: item.word.toLowerCase(),
      stage: item.stage,
      due: item.due,
    };
    if (typeof item.contextSentence === 'string' && item.contextSentence.trim()) {
      parsedItem.contextSentence = item.contextSentence.trim().slice(0, 240);
    }
    if (typeof item.contextTranslation === 'string' && item.contextTranslation.trim()) {
      parsedItem.contextTranslation = item.contextTranslation.trim().slice(0, 240);
    }
    items.push(parsedItem);
  }
  return items;
}
