import type { OcrLine, OcrSentence, OcrWord, Point, Quad } from '@kea/shared-types';

function splitMeaningParts(text: string): string[] {
  return text
    .split(/[；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const ABBREVIATIONS = /^(mr|mrs|ms|dr|st|no|vs|etc)\.?$/i;
const SENTENCE_END_RE = /[.?!]["'”’)]*$/;
const ALLOWED_TRAILING_PUNCT = /([.,?!;:]+)["'”’)]*$/;
const LEADING_QUOTE_RE = /^["'“‘(]+/;

/** 合并多个词框为一个外接矩形 Quad */
export function mergeQuads(quads: readonly Quad[]): Quad {
  if (quads.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const quad of quads) {
    for (const pt of quad) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }

  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1e6) / 1e6;
  const x0 = clamp(minX);
  const y0 = clamp(minY);
  const x1 = clamp(maxX);
  const y1 = clamp(maxY);

  return [
    { x: x0, y: y0 } as Point,
    { x: x1, y: y0 } as Point,
    { x: x1, y: y1 } as Point,
    { x: x0, y: y1 } as Point,
  ];
}

/** 从 OcrWord 还原带合理标点的展示词与句末断句信号 */
export function formatTokenWithPunctuation(word: OcrWord): {
  token: string;
  endsSentence: boolean;
} {
  const raw = (word.rawText ?? word.text).trim().replace(LEADING_QUOTE_RE, '');
  const match = ALLOWED_TRAILING_PUNCT.exec(raw);
  const punct = match?.[1] ? match[1].slice(-1) : '';
  const token = punct ? `${word.text}${punct}` : word.text;
  const endsSentence =
    SENTENCE_END_RE.test(raw) && !ABBREVIATIONS.test(raw) && word.text.length >= 1;
  return { token, endsSentence };
}

interface LineGroup {
  lineId: string;
  words: OcrWord[];
  quad: Quad;
}

function shouldMergeWrappedLine(prev: LineGroup, next: LineGroup): boolean {
  if (prev.words.length < 3 || next.words.length === 0) return false;

  const lastWord = prev.words[prev.words.length - 1]!;
  const { endsSentence } = formatTokenWithPunctuation(lastWord);
  if (endsSentence) return false;

  const prevTop = prev.quad[0].y;
  const prevBottom = prev.quad[2].y;
  const prevHeight = Math.max(0.008, prevBottom - prevTop);

  const nextTop = next.quad[0].y;
  const nextBottom = next.quad[2].y;
  const nextHeight = Math.max(0.008, nextBottom - nextTop);

  // 字高差异过大（如标题与正文）不合并
  const heightRatio = Math.max(prevHeight, nextHeight) / Math.min(prevHeight, nextHeight);
  if (heightRatio > 1.65) return false;

  // 垂直间距需紧凑（折行通常在 1.35 倍行高以内）
  const verticalGap = nextTop - prevBottom;
  if (verticalGap < -prevHeight * 0.4 || verticalGap > Math.max(prevHeight, nextHeight) * 1.35) {
    return false;
  }

  // 左边缘在同一栏范围内
  const leftDiff = Math.abs(next.quad[0].x - prev.quad[0].x);
  if (leftDiff > 0.2) return false;

  return true;
}

function defaultWordTrusted(word: OcrWord): boolean {
  return word.lexiconHit && word.confidence >= 0.7;
}

/**
 * 从 OCR 词流与行信息中重组完整句子。
 * - 自动处理段落内跨行折行合并与同行多句切分
 * - 计算可信句子门控（至少 2 个词且可信词占比 >= 60%）
 */
export function buildSentences(
  words: readonly OcrWord[],
  _lines: readonly OcrLine[] = [],
  isWordTrusted: (word: OcrWord) => boolean = defaultWordTrusted,
): OcrSentence[] {
  if (words.length === 0) return [];

  // 1. 按 lineId 聚合为有序行
  const lineMap = new Map<string, OcrWord[]>();
  for (const word of words) {
    const bucket = lineMap.get(word.lineId);
    if (bucket) {
      bucket.push(word);
    } else {
      lineMap.set(word.lineId, [word]);
    }
  }

  const rawLines: LineGroup[] = [];
  for (const [lineId, lineWords] of lineMap.entries()) {
    const sorted = [...lineWords].sort((a, b) => a.indexInLine - b.indexInLine);
    rawLines.push({
      lineId,
      words: sorted,
      quad: mergeQuads(sorted.map((w) => w.quad)),
    });
  }

  // 2. 合并跨行折行
  const mergedGroups: OcrWord[][] = [];
  let currentGroup: LineGroup | null = null;

  for (const line of rawLines) {
    if (!currentGroup) {
      currentGroup = { ...line, words: [...line.words] };
      continue;
    }

    if (shouldMergeWrappedLine(currentGroup, line)) {
      const combinedWords: OcrWord[] = [...currentGroup.words, ...line.words];
      currentGroup = {
        lineId: currentGroup.lineId,
        words: combinedWords,
        quad: mergeQuads(combinedWords.map((w) => w.quad)),
      };
    } else {
      mergedGroups.push(currentGroup.words);
      currentGroup = { ...line, words: [...line.words] };
    }
  }
  if (currentGroup) {
    mergedGroups.push(currentGroup.words);
  }

  // 3. 在每个行组内部按句末标点切分句子（单字感叹词如 "Hello!" 若同行紧跟正文则合并成一句）
  const sentenceWordBuckets: OcrWord[][] = [];
  for (const groupWords of mergedGroups) {
    let buffer: OcrWord[] = [];
    for (let i = 0; i < groupWords.length; i += 1) {
      const word = groupWords[i]!;
      buffer.push(word);
      const { endsSentence } = formatTokenWithPunctuation(word);
      const isLastInGroup = i === groupWords.length - 1;
      if (endsSentence && !isLastInGroup && buffer.length >= 2) {
        sentenceWordBuckets.push(buffer);
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      sentenceWordBuckets.push(buffer);
    }
  }

  // 4. 生成 OcrSentence 并计算可信度
  const sentences: OcrSentence[] = [];
  for (const bucket of sentenceWordBuckets) {
    if (bucket.length === 0) continue;

    const tokens = bucket.map((w) => formatTokenWithPunctuation(w).token);
    let text = tokens.join(' ');
    if (!/[.?!]$/.test(text)) {
      text = `${text}.`;
    }
    // 首字母大写规范化（仅展示层，不改原词）
    text = text.charAt(0).toUpperCase() + text.slice(1);

    const totalConfidence = bucket.reduce((sum, w) => sum + w.confidence, 0);
    const avgConfidence = totalConfidence / bucket.length;
    const trustedWordCount = bucket.filter(isWordTrusted).length;
    const trustedRatio = trustedWordCount / bucket.length;

    const trusted = bucket.length >= 2 && trustedWordCount >= 1 && trustedRatio >= 0.6;

    sentences.push({
      id: `s${sentences.length}`,
      text,
      wordIds: bucket.map((w) => w.id),
      quad: mergeQuads(bucket.map((w) => w.quad)),
      confidence: Math.round(avgConfidence * 1000) / 1000,
      trusted,
    });
  }

  return sentences;
}

/** 查找某个单词所属的可信完整句子 */
export function findSentenceForWord(
  sentences: readonly OcrSentence[],
  wordId: string,
): OcrSentence | null {
  const hit = sentences.find((s) => s.wordIds.includes(wordId));
  return hit && hit.trusted ? hit : null;
}

/* ---------- 离线高频句型精准翻译与诚实词义拆解 ---------- */

/** 归一化句子用于缓存键与模板匹配 */
export function normalizeSentenceKey(text: string): string {
  return text
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const EXACT_SENTENCES: Record<string, string> = {
  'hello.': '你好。',
  'hello!': '你好！',
  'hi!': '嗨，你好！',
  'good morning.': '早上好。',
  'good morning!': '早上好！',
  'good afternoon.': '下午好。',
  'good afternoon!': '下午好！',
  'good evening.': '晚上好。',
  'good night.': '晚安。',
  'good night!': '晚安！',
  'goodbye.': '再见。',
  'goodbye!': '再见！',
  'bye-bye!': '拜拜，再见！',
  'see you.': '再见。',
  'see you!': '再见！',
  'see you tomorrow.': '明天见。',
  'how are you?': '你好吗？',
  'i am fine, thank you.': '我很好，谢谢你。',
  "i'm fine, thank you.": '我很好，谢谢你。',
  'fine, thank you.': '很好，谢谢你。',
  'nice to meet you.': '很高兴认识你。',
  'nice to meet you!': '很高兴认识你！',
  'nice to meet you, too.': '我也很高兴认识你。',
  'thank you.': '谢谢你。',
  'thank you!': '谢谢你！',
  'thank you very much.': '非常感谢你。',
  'thanks a lot.': '非常感谢。',
  "you are welcome.": '不客气。',
  "you're welcome.": '不客气。',
  'excuse me.': '打扰一下。',
  'i am sorry.': '对不起。',
  "i'm sorry.": '对不起。',
  "that's ok.": '没关系。',
  "it's ok.": '没关系。',
  'what is your name?': '你叫什么名字？',
  "what's your name?": '你叫什么名字？',
  'how old are you?': '你几岁了？',
  'where are you from?': '你来自哪里？',
  'what time is it?': '现在几点了？',
  'what day is it today?': '今天星期几？',
  "what's the weather like today?": '今天天气怎么样？',
  'can i help you?': '我能帮你吗？',
  'here you are.': '给你。',
  'have a good time!': '玩得开心！',
  'happy birthday!': '生日快乐！',
  'happy birthday to you!': '祝你生日快乐！',
  'open your book.': '打开你的书。',
  'close your book.': '合上你的书。',
  'stand up.': '起立。',
  'sit down.': '请坐。',
  'sit down, please.': '请坐。',
  'listen to me.': '听我说。',
  'look at me.': '看着我。',
  'look at the blackboard.': '看黑板。',
  'let us go.': '我们走吧。',
  "let's go.": '我们走吧。',
  "let's go!": '我们出发吧！',
  "let's play.": '我们一起玩吧。',
  "let's play!": '我们一起玩吧！',
  "let's read.": '我们一起来读吧。',
};

function firstGloss(meaning: string | null | undefined): string | null {
  if (!meaning) return null;
  const items = splitMeaningParts(meaning).filter(
    (s) => /[\u4e00-\u9fff]/.test(s) && !s.includes('先听读音'),
  );
  return items[0] ?? null;
}

function cleanNounPhrase(
  raw: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const words = raw
    .trim()
    .replace(/^(a|an|the|my|your|his|her|our|their|this|that|some|any)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0 || words.length > 3) return null;

  const prefixMatch = /^(my|your|his|her|our|their|this|that)\s+/i.exec(raw.trim());
  const prefixMap: Record<string, string> = {
    my: '我的',
    your: '你的',
    his: '他的',
    her: '她的',
    our: '我们的',
    their: '他们的',
    this: '这个',
    that: '那个',
  };
  const prefix = prefixMatch?.[1] ? (prefixMap[prefixMatch[1].toLowerCase()] ?? '') : '';

  if (!lookupMeaning) return null;

  const translated: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z'-]/g, '');
    if (!clean) return null;
    const gloss = firstGloss(lookupMeaning(clean));
    if (!gloss) return null;
    translated.push(gloss);
  }

  return `${prefix}${translated.join('')}`;
}

/**
 * 匹配高置信小学英语固定句型模板。
 * 只有 100% 把握的句型才返回完整译文；不确定时返回 null，交由大模型或诚实词义拆解兜底。
 */
export function matchHighConfidenceTemplate(
  sentence: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const key = normalizeSentenceKey(sentence);
  const exact = EXACT_SENTENCES[key];
  if (exact) return exact;

  const body = key.replace(/[.?!]+$/, '').trim();

  // 1. My name is X. / I am X.
  const nameMatch = /^my name is ([a-z]+)$/i.exec(body);
  if (nameMatch?.[1]) {
    const name = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
    return `我的名字叫 ${name}。`;
  }

  // 2. I am N years old.
  const ageMatch = /^(?:i am|i'm) (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) years old$/i.exec(
    body,
  );
  if (ageMatch?.[1]) {
    const numMap: Record<string, string> = {
      one: '一',
      two: '两',
      three: '三',
      four: '四',
      five: '五',
      six: '六',
      seven: '七',
      eight: '八',
      nine: '九',
      ten: '十',
      eleven: '十一',
      twelve: '十二',
    };
    const age = numMap[ageMatch[1].toLowerCase()] ?? ageMatch[1];
    return `我今年${age}岁了。`;
  }

  // 3. I like / don't like X.
  const likeMatch = /^i (do not|don't )?like ([a-z\s]+)$/i.exec(body);
  if (likeMatch?.[2]) {
    const neg = Boolean(likeMatch[1]);
    const obj = cleanNounPhrase(likeMatch[2], lookupMeaning);
    if (obj) return `我${neg ? '不' : ''}喜欢${obj}。`;
  }

  // 4. Do you like X?
  const doYouLikeMatch = /^do you like ([a-z\s]+)$/i.exec(body);
  if (doYouLikeMatch?.[1] && key.endsWith('?')) {
    const obj = cleanNounPhrase(doYouLikeMatch[1], lookupMeaning);
    if (obj) return `你喜欢${obj}吗？`;
  }

  // 5. This is / That is X.
  const thisIsMatch = /^(this|that|it) is ([a-z\s]+)$/i.exec(body);
  if (thisIsMatch?.[1] && thisIsMatch[2] && !key.endsWith('?')) {
    const subjMap: Record<string, string> = { this: '这是', that: '那是', it: '它是' };
    const obj = cleanNounPhrase(thisIsMatch[2], lookupMeaning);
    if (obj) return `${subjMap[thisIsMatch[1].toLowerCase()] ?? '这是'}${obj}。`;
  }

  // 6. What is this / that?
  if (body === 'what is this' || body === "what's this") return '这是什么？';
  if (body === 'what is that' || body === "what's that") return '那是什么？';

  // 7. Where is X?
  const whereIsMatch = /^where (?:is|are) ([a-z\s]+)$/i.exec(body);
  if (whereIsMatch?.[1] && key.endsWith('?')) {
    const obj = cleanNounPhrase(whereIsMatch[1], lookupMeaning);
    if (obj) return `${obj}在哪里？`;
  }

  // 8. Let's go to X (together).
  const letsGoMatch = /^let(?:'s| us) go to ([a-z\s]+?)(?:\s+together)?$/i.exec(body);
  if (letsGoMatch?.[1]) {
    const together = /\btogether$/.test(body);
    const place = cleanNounPhrase(letsGoMatch[1], lookupMeaning);
    if (place) return `我们${together ? '一起' : ''}去${place}吧！`;
  }

  // 9. I have X.
  const haveMatch = /^i have ([a-z\s]+)$/i.exec(body);
  if (haveMatch?.[1]) {
    const obj = cleanNounPhrase(haveMatch[1], lookupMeaning);
    if (obj) return `我有${obj}。`;
  }

  return null;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'it',
  'do',
  'does',
  'did',
]);

export interface WordGlossItem {
  word: string;
  meaning: string;
}

/**
 * 为句子提取句内重点实词的中文释义列表（用于断网/未配 Key 时的诚实词义拆解，以及句子卡的重点词展示）
 */
export function buildSentenceWordBreakdown(
  words: readonly string[],
  lookupMeaning: (word: string) => string | null,
): WordGlossItem[] {
  const seen = new Set<string>();
  const items: WordGlossItem[] = [];

  for (const raw of words) {
    const clean = raw.replace(/[^a-zA-Z'-]/g, '');
    const lower = clean.toLowerCase();
    if (!lower || lower.length < 2 || seen.has(lower)) continue;
    if (STOP_WORDS.has(lower) && words.length > 3) continue;

    const meaning = firstGloss(lookupMeaning(clean));
    if (!meaning) continue;

    seen.add(lower);
    items.push({ word: clean, meaning });
    if (items.length >= 6) break;
  }

  return items;
}
