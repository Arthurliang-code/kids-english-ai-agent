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
  startsNewItem: boolean;
  isHeading: boolean;
  optionCutoffX: number | null;
}

const KNOWN_ACRONYMS = /^(TV|PE|OK|UK|US|USA|CD|DVD|ID|IT)$/;
const NEW_ITEM_PREFIX =
  /^\s*(?:[—\-*•]?\s*\d{1,2}\s*[.)、]|[(（]\d{1,2}[)）]|part\s+\d+|unit\s+\d+|[A-Z][A-Za-z]{0,12}\s*[:：])/i;
const HEADING_LINE =
  /^\s*(?:(?:unit|lesson|module|chapter|part)\s+(?:\d+|[ivx]+)\b.*|word\s*list\s*)$/i;
const OPTION_LINE = /^\s*[A-D]\.\s*\S+/i;
const SPEAKER_TOKEN = /^[A-Z][:：]$/;
const PAREN_NOISE = /^[（(].*[）)]$/;

function defaultWordTrusted(word: OcrWord): boolean {
  return word.lexiconHit && word.confidence >= 0.7;
}

/** 判断是否为单选题选项起点（如 A. / B. / A.sing / B.sings） */
function isOptionMarker(word: OcrWord, nextWord: OcrWord | undefined): boolean {
  const raw = (word.rawText ?? word.text).trim();
  if (/^[A-D]\./i.test(raw)) return true;
  if (/^[B-D]$/i.test(word.text) && nextWord !== undefined) return true;
  return false;
}

/** 两个片段的 Y 轴重叠度（占较矮片段高度的比例） */
function verticalOverlapRatio(a: LineGroup, b: LineGroup): number {
  const aTop = a.quad[0].y;
  const aBottom = a.quad[2].y;
  const bTop = b.quad[0].y;
  const bBottom = b.quad[2].y;
  const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  const minH = Math.max(0.006, Math.min(aBottom - aTop, bBottom - bTop));
  return overlap / minH;
}

/** 判断同一视觉行中两段是否有足够的 Y 轴重叠且水平相邻（允许填空下划线的间距） */
function areOnSameVisualRow(prev: LineGroup, next: LineGroup): boolean {
  if (verticalOverlapRatio(prev, next) < 0.35) return false;
  const gapRight = next.quad[0].x - prev.quad[1].x;
  const gapLeft = prev.quad[0].x - next.quad[1].x;
  const gapX = Math.max(gapRight, gapLeft);
  return gapX <= 0.22;
}

/** 判断一行是否为中文误识出的大写/碎字母乱码行 */
function isLikelyChineseGibberish(words: readonly OcrWord[], rawLineText: string): boolean {
  if (words.length === 0) return true;

  // 若原行里包含多个连续纯小写常用英文词，通常不是中文误识
  let cleanNormalWords = 0;
  let allCapsOrTinyNoise = 0;

  for (const w of words) {
    const raw = (w.rawText ?? w.text).trim();
    const isAllCaps = /^[A-Z.,:;!?]+$/.test(raw) && w.text.length >= 2;
    const isHighRealWord =
      w.lexiconHit &&
      w.confidence >= 0.72 &&
      !KNOWN_ACRONYMS.test(w.text) &&
      !(isAllCaps && w.confidence < 0.88);

    if (isHighRealWord && !isAllCaps) {
      cleanNormalWords += 1;
    }
    if (isAllCaps && !KNOWN_ACRONYMS.test(w.text) && w.confidence < 0.88) {
      allCapsOrTinyNoise += 1;
    }
  }

  // 检查原始行中是否有大量非字母碎片
  const rawChunks = rawLineText
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^\d+[.)、]?$/.test(s));

  if (allCapsOrTinyNoise >= 2 && cleanNormalWords <= 1) return true;
  if (rawChunks.length >= 4 && cleanNormalWords / rawChunks.length < 0.35) return true;
  if (words.length >= 2 && cleanNormalWords === 0 && !KNOWN_ACRONYMS.test(words[0]!.text)) {
    return true;
  }

  return false;
}

/** 从原行文本估计是否有 "[.?!] A. xxx B. xxx" 选择题选项的起点比例 */
function detectInlineOptionCutoff(rawText: string, lineQuad: Quad): number | null {
  const m = /^(.*?[.?!])\s+([A-D]\.\s*\S+.*)$/.exec(rawText);
  if (!m || !m[1]) return null;
  const lineW = lineQuad[1].x - lineQuad[0].x;
  if (lineW <= 0) return null;
  const ratio = m[1].length / Math.max(1, rawText.length);
  return lineQuad[0].x + lineW * (ratio + 0.015);
}

function cleanRowWords(
  words: readonly OcrWord[],
  optionCutoffX: number | null,
  isWordTrusted: (word: OcrWord) => boolean,
): OcrWord[] {
  const out: OcrWord[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const raw = (w.rawText ?? w.text).trim();

    if (optionCutoffX !== null && w.quad[0].x >= optionCutoffX) {
      break;
    }
    if (i === 0 && SPEAKER_TOKEN.test(raw)) {
      continue;
    }
    if (out.length >= 3 && isOptionMarker(w, words[i + 1])) {
      break;
    }
    // 跳过如 "(BASES)"、"(RATES)" 这类行尾括号中文误识碎片
    if (PAREN_NOISE.test(raw) && (/^[（(][A-Z]+[）)]$/.test(raw) || w.confidence < 0.78)) {
      continue;
    }
    // 行尾独立的低置信全大写 2-5 字母碎片（如 EES / HA / RA）
    if (
      /^[A-Z]{2,5}[.,]?$/.test(raw) &&
      !KNOWN_ACRONYMS.test(w.text) &&
      w.confidence < 0.85 &&
      out.length >= 2
    ) {
      continue;
    }
    if (/^[a-z]{1,2}[A-Z]{1,3}[.,?!]*$/.test(raw)) {
      continue;
    }
    if (w.lexiconHit || isWordTrusted(w)) {
      out.push(w);
    }
  }
  return out;
}

function shouldMergeWrappedLine(prev: LineGroup, next: LineGroup): boolean {
  if (prev.words.length < 2 || next.words.length === 0) return false;
  if (prev.isHeading || next.isHeading || next.startsNewItem) return false;

  const lastWord = prev.words[prev.words.length - 1]!;
  const { endsSentence } = formatTokenWithPunctuation(lastWord);
  if (endsSentence) return false;

  const prevTop = prev.quad[0].y;
  const prevBottom = prev.quad[2].y;
  const prevHeight = Math.max(0.008, prevBottom - prevTop);

  const nextTop = next.quad[0].y;
  const nextBottom = next.quad[2].y;
  const nextHeight = Math.max(0.008, nextBottom - nextTop);

  // 字高差距超过 1.32 倍（例如 Unit 大标题与正文）绝不合并
  const heightRatio = Math.max(prevHeight, nextHeight) / Math.min(prevHeight, nextHeight);
  if (heightRatio > 1.32) return false;

  const verticalGap = nextTop - prevBottom;
  if (verticalGap < -prevHeight * 0.35 || verticalGap > Math.max(prevHeight, nextHeight) * 1.25) {
    return false;
  }

  const leftDiff = Math.abs(next.quad[0].x - prev.quad[0].x);
  if (leftDiff > 0.16) return false;

  return true;
}

/**
 * 从 OCR 词流与行信息中重组完整句子。
 * - 先合并同一视觉横行上被 SPARSE_TEXT 切碎的词段
 * - 识别题号、对话说话人、标题边界，过滤中文误识碎片与选择题选项
 * - 处理段落内跨行折行合并与同行多句切分
 */
export function buildSentences(
  words: readonly OcrWord[],
  lines: readonly OcrLine[] = [],
  isWordTrusted: (word: OcrWord) => boolean = defaultWordTrusted,
): OcrSentence[] {
  if (words.length === 0) return [];

  const metaByLineId = new Map<string, OcrLine>();
  for (const l of lines) {
    metaByLineId.set(l.id, l);
  }

  const lineMap = new Map<string, OcrWord[]>();
  for (const word of words) {
    const bucket = lineMap.get(word.lineId);
    if (bucket) {
      bucket.push(word);
    } else {
      lineMap.set(word.lineId, [word]);
    }
  }

  // 1. 构造原始行片段，清理每段乱码并记录结构标记
  const segments: LineGroup[] = [];
  for (const [lineId, lineWords] of lineMap.entries()) {
    const sorted = [...lineWords].sort((a, b) => a.indexInLine - b.indexInLine);
    const meta = metaByLineId.get(lineId);
    const rawText = meta?.text?.trim() ?? sorted.map((w) => w.rawText ?? w.text).join(' ');
    if (OPTION_LINE.test(rawText)) continue;
    const lineQuad = meta?.quad ?? mergeQuads(sorted.map((w) => w.quad));
    const optionCutoffX = detectInlineOptionCutoff(rawText, lineQuad);

    const cleaned = cleanRowWords(sorted, optionCutoffX, isWordTrusted);
    if (cleaned.length === 0) continue;
    if (cleaned.length === 1 && cleaned[0]!.text.length === 1 && !/^[aI]$/.test(cleaned[0]!.text)) {
      continue;
    }
    if (isLikelyChineseGibberish(cleaned, rawText)) continue;

    segments.push({
      lineId,
      words: cleaned,
      quad: mergeQuads(cleaned.map((w) => w.quad)),
      startsNewItem: NEW_ITEM_PREFIX.test(rawText),
      isHeading: HEADING_LINE.test(rawText),
      optionCutoffX,
    });
  }

  if (segments.length === 0) return [];

  // 2. 按视觉坐标（Y 从上到下，同行 X 从左到右）排序并合并同一横行上的碎片
  segments.sort((a, b) => a.quad[0].y - b.quad[0].y || a.quad[0].x - b.quad[0].x);

  const visualRows: LineGroup[] = [];
  for (const seg of segments) {
    const prev = visualRows[visualRows.length - 1];
    if (prev && areOnSameVisualRow(prev, seg)) {
      const combined = [...prev.words, ...seg.words].sort((a, b) => a.quad[0].x - b.quad[0].x);
      // 同行合并后再次检查选项截断 (例如行1题目 + 行2选项A)
      const trimmed = cleanRowWords(combined, null, isWordTrusted);
      if (trimmed.length > 0) {
        prev.words = trimmed;
        prev.quad = mergeQuads(trimmed.map((w) => w.quad));
        prev.startsNewItem = prev.startsNewItem || seg.startsNewItem;
        prev.isHeading = prev.isHeading || seg.isHeading;
      }
    } else {
      visualRows.push({ ...seg, words: [...seg.words] });
    }
  }

  // 3. 合并同一段落内的跨行折行（不跨题号、不跨标题、不跨句末标点）
  const mergedGroups: OcrWord[][] = [];
  let currentGroup: LineGroup | null = null;

  for (const row of visualRows) {
    if (!currentGroup) {
      currentGroup = { ...row, words: [...row.words] };
      continue;
    }

    if (shouldMergeWrappedLine(currentGroup, row)) {
      const combinedWords: OcrWord[] = [...currentGroup.words, ...row.words];
      currentGroup = {
        ...currentGroup,
        words: combinedWords,
        quad: mergeQuads(combinedWords.map((w) => w.quad)),
      };
    } else {
      mergedGroups.push(currentGroup.words);
      currentGroup = { ...row, words: [...row.words] };
    }
  }
  if (currentGroup) {
    mergedGroups.push(currentGroup.words);
  }

  // 4. 在行组内按句末标点切分独立句子
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

  // 5. 生成 OcrSentence 与可信判定
  const sentences: OcrSentence[] = [];
  for (const bucket of sentenceWordBuckets) {
    if (bucket.length === 0) continue;

    const tokens = bucket.map((w) => formatTokenWithPunctuation(w).token);
    let text = tokens.join(' ');
    if (!/[.?!]$/.test(text)) {
      text = `${text.replace(/[,;:]+$/, '')}.`;
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);

    const totalConfidence = bucket.reduce((sum, w) => sum + w.confidence, 0);
    const avgConfidence = totalConfidence / bucket.length;
    const realWordCount = bucket.filter(
      (w) => isWordTrusted(w) && (w.text.length >= 2 || /^[aI]$/.test(w.text)),
    ).length;
    const trustedRatio = realWordCount / bucket.length;

    const trusted = bucket.length >= 2 && realWordCount >= 2 && trustedRatio >= 0.7;

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

/* ---------- 整句自然达意翻译引擎（句型 + 语法语序重排） ---------- */

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
  'you are welcome.': '不客气。',
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
  'word list.': '单词表',
  'word list': '单词表',
  'this is my family.': '这是我的家庭。',
  'my father is a doctor.': '我的爸爸是一名医生。',
  'my mother is a teacher.': '我的妈妈是一名老师。',
  'i have a little brother.': '我有一个小弟弟。',
  'i have a little sister.': '我有一个小妹妹。',
  'we like to read books together.': '我们喜欢一起看书。',
  'the apple is red and sweet.': '这个苹果又红又甜。',
  'look at the yellow banana.': '看那根黄色的香蕉。',
};

/** 精确命中无歧义固定高频句，无需消耗在线翻译/大模型 Token */
export function matchExactSentence(sentence: string): string | null {
  return EXACT_SENTENCES[normalizeSentenceKey(sentence)] ?? null;
}

/** 针对儿童教材优化的核心词精准单义表（解决词典首义不合语境问题） */
const KID_WORD_GLOSS: Record<string, string> = {
  i: '我',
  me: '我',
  my: '我的',
  mine: '我的',
  you: '你',
  your: '你的',
  yours: '你的',
  he: '他',
  him: '他',
  his: '他的',
  she: '她',
  her: '她的',
  hers: '她的',
  it: '它',
  its: '它的',
  we: '我们',
  us: '我们',
  our: '我们的',
  ours: '我们的',
  they: '他们',
  them: '他们',
  their: '他们的',
  this: '这个',
  that: '那个',
  these: '这些',
  those: '那些',
  family: '家庭',
  father: '爸爸',
  dad: '爸爸',
  mother: '妈妈',
  mom: '妈妈',
  mum: '妈妈',
  parent: '父母',
  parents: '父母',
  brother: '兄弟',
  sister: '姐妹',
  grandpa: '爷爷',
  grandfather: '爷爷',
  grandma: '奶奶',
  grandmother: '奶奶',
  uncle: '叔叔',
  aunt: '阿姨',
  cousin: '堂兄妹',
  baby: '宝宝',
  boy: '男孩',
  boys: '男孩们',
  girl: '女孩',
  girls: '女孩们',
  child: '孩子',
  children: '孩子们',
  man: '男人',
  men: '男人们',
  woman: '女人',
  women: '女人们',
  friend: '朋友',
  friends: '朋友们',
  student: '学生',
  students: '学生们',
  pupil: '小学生',
  teacher: '老师',
  teachers: '老师们',
  doctor: '医生',
  nurse: '护士',
  driver: '司机',
  farmer: '农民',
  cook: '厨师',
  worker: '工人',
  policeman: '警察',
  player: '运动员',
  apple: '苹果',
  apples: '苹果',
  banana: '香蕉',
  bananas: '香蕉',
  orange: '橙子',
  oranges: '橙子',
  pear: '梨',
  pears: '梨',
  grape: '葡萄',
  grapes: '葡萄',
  peach: '桃子',
  watermelon: '西瓜',
  strawberry: '草莓',
  fruit: '水果',
  bread: '面包',
  cake: '蛋糕',
  milk: '牛奶',
  water: '水',
  juice: '果汁',
  tea: '茶',
  egg: '鸡蛋',
  eggs: '鸡蛋',
  rice: '米饭',
  noodles: '面条',
  fish: '鱼',
  chicken: '鸡肉',
  meat: '肉',
  soup: '汤',
  lunch: '午餐',
  breakfast: '早餐',
  dinner: '晚餐',
  food: '食物',
  cat: '猫',
  cats: '猫',
  dog: '狗',
  dogs: '狗',
  bird: '鸟',
  birds: '鸟',
  duck: '鸭子',
  ducks: '鸭子',
  pig: '小猪',
  cow: '奶牛',
  horse: '马',
  sheep: '绵羊',
  monkey: '猴子',
  panda: '熊猫',
  tiger: '老虎',
  lion: '狮子',
  elephant: '大象',
  bear: '熊',
  rabbit: '兔子',
  zoo: '动物园',
  animal: '动物',
  animals: '动物',
  book: '书',
  books: '书',
  pen: '钢笔',
  pencil: '铅笔',
  ruler: '尺子',
  eraser: '橡皮',
  bag: '包',
  schoolbag: '书包',
  desk: '书桌',
  chair: '椅子',
  table: '桌子',
  bed: '床',
  door: '门',
  window: '窗户',
  room: '房间',
  classroom: '教室',
  school: '学校',
  library: '图书馆',
  playground: '操场',
  park: '公园',
  home: '家',
  house: '房子',
  garden: '花园',
  shop: '商店',
  hospital: '医院',
  museum: '博物馆',
  hall: '礼堂',
  tree: '树',
  trees: '树',
  flower: '花',
  flowers: '花',
  grass: '草地',
  river: '河',
  lake: '湖',
  sky: '天空',
  sun: '太阳',
  moon: '月亮',
  star: '星星',
  cloud: '云',
  rain: '雨',
  snow: '雪',
  wind: '风',
  car: '小汽车',
  bus: '公交车',
  bike: '自行车',
  train: '火车',
  plane: '飞机',
  boat: '小船',
  ship: '轮船',
  dress: '连衣裙',
  shirt: '衬衫',
  skirt: '短裙',
  coat: '外套',
  sweater: '毛衣',
  hat: '帽子',
  cap: '帽子',
  shoe: '鞋子',
  shoes: '鞋子',
  socks: '袜子',
  red: '红色的',
  yellow: '黄色的',
  blue: '蓝色的',
  green: '绿色的',
  white: '白色的',
  black: '黑色的',
  orange_adj: '橙色的',
  pink: '粉色的',
  purple: '紫色的',
  brown: '棕色的',
  big: '大的',
  small: '小的',
  little: '小的',
  tall: '高的',
  taller: '更高的',
  tallest: '最高的',
  short: '矮的/短的',
  long: '长的',
  new: '新的',
  old: '旧的/年老的',
  young: '年轻的',
  good: '好的',
  better: '更好的',
  best: '最好的',
  nice: '美好的',
  fine: '好的',
  happy: '开心的',
  sad: '难过的',
  angry: '生气的',
  tired: '累的',
  hungry: '饿的',
  thirsty: '渴的',
  hot: '热的',
  cold: '冷的',
  warm: '温暖的',
  cool: '凉爽的',
  sunny: '晴朗的',
  rainy: '下雨的',
  windy: '刮风的',
  cloudy: '多云的',
  snowy: '下雪的',
  sweet: '甜的',
  cute: '可爱的',
  beautiful: '美丽的',
  clever: '聪明的',
  kind: '友善的',
  quiet: '安静的',
  fast: '快的',
  slow: '慢的',
  heavy: '重的',
  heavier: '更重的',
  light: '轻的',
  clean: '干净的',
  dirty: '脏的',
  interesting: '有趣的',
  easy: '容易的',
  difficult: '困难的',
  many: '许多',
  much: '许多',
  some: '一些',
  any: '一些',
  all: '所有',
  every: '每个',
  one: '一',
  two: '二',
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
  twenty: '二十',
  first: '第一',
  second: '第二',
  third: '第三',
  go: '去',
  goes: '去',
  went: '去了',
  going: '去',
  come: '来',
  came: '来了',
  coming: '来',
  like: '喜欢',
  likes: '喜欢',
  liked: '喜欢',
  love: '喜爱',
  loves: '喜爱',
  have: '有',
  has: '有',
  had: '有',
  want: '想要',
  wants: '想要',
  eat: '吃',
  eats: '吃',
  ate: '吃了',
  eating: '吃',
  drink: '喝',
  drinks: '喝',
  drank: '喝了',
  drinking: '喝',
  read: '读/看',
  reads: '读/看',
  reading: '读书',
  write: '写',
  writes: '写',
  wrote: '写了',
  writing: '写',
  draw: '画',
  draws: '画',
  drawing: '画画',
  sing: '唱歌',
  sings: '唱歌',
  sang: '唱了歌',
  singing: '唱歌',
  dance: '跳舞',
  dances: '跳舞',
  dancing: '跳舞',
  play: '玩',
  plays: '玩',
  played: '玩了',
  playing: '玩',
  run: '跑',
  runs: '跑',
  ran: '跑了',
  running: '跑步',
  jump: '跳',
  jumping: '跳',
  swim: '游泳',
  swims: '游泳',
  swimming: '游泳',
  fly: '飞',
  flying: '飞',
  walk: '走',
  walking: '走路',
  sleep: '睡觉',
  sleeping: '睡觉',
  look: '看',
  looks: '看起来',
  looking: '看',
  see: '看见',
  saw: '看见了',
  watch: '观看',
  watches: '看',
  watched: '看了',
  watching: '观看',
  listen: '听',
  listening: '听',
  speak: '说',
  speaks: '说',
  spoke: '说了',
  speaking: '说',
  say: '说',
  says: '说',
  said: '说了',
  talk: '交谈',
  talking: '交谈',
  buy: '买',
  buys: '买',
  bought: '买了',
  make: '制作',
  makes: '制作',
  made: '制作了',
  making: '制作',
  cook_v: '做饭',
  cooking: '做饭',
  clean_v: '打扫',
  cleaned: '打扫了',
  cleaning: '打扫',
  wash: '洗',
  washed: '洗了',
  washing: '洗',
  help: '帮助',
  helped: '帮助了',
  helping: '帮助',
  visit: '参观/看望',
  visits: '参观/看望',
  visited: '参观了',
  visiting: '参观',
  study: '学习',
  studies: '学习',
  studied: '学习了',
  studying: '学习',
  learn: '学习',
  learning: '学习',
  open: '打开',
  close: '关上/合上',
  put: '放',
  take: '拿/带',
  took: '带了',
  give: '给',
  gave: '给了',
  wear: '穿/戴',
  wearing: '穿着',
  live: '居住',
  lives: '住在',
  know: '知道',
  think: '觉得/认为',
  english: '英语',
  chinese: '中文/语文',
  math: '数学',
  music: '音乐',
  art: '美术',
  pe: '体育',
  football: '足球',
  basketball: '篮球',
  pingpong: '乒乓球',
  piano: '钢琴',
  violin: '小提琴',
  guitar: '吉他',
  tv: '电视',
  game: '游戏',
  games: '游戏',
  story: '故事',
  stories: '故事',
  picture: '图画/照片',
  pictures: '图画/照片',
  party: '聚会',
  birthday: '生日',
  name: '名字',
  time: '时间',
  day: '天',
  today: '今天',
  tomorrow: '明天',
  yesterday: '昨天',
  morning: '早上',
  afternoon: '下午',
  evening: '晚上',
  night: '夜晚',
  sunday: '星期日',
  monday: '星期一',
  tuesday: '星期二',
  wednesday: '星期三',
  thursday: '星期四',
  friday: '星期五',
  saturday: '星期六',
  week: '周/星期',
  month: '月',
  year: '年',
  january: '一月',
  february: '二月',
  march: '三月',
  april: '四月',
  may: '五月',
  june: '六月',
  july: '七月',
  august: '八月',
  september: '九月',
  october: '十月',
  november: '十一月',
  december: '十二月',
  spring: '春天',
  summer: '夏天',
  autumn: '秋天',
  fall: '秋天',
  winter: '冬天',
  china: '中国',
  beijing: '北京',
  shanghai: '上海',
  london: '伦敦',
  together: '一起',
  very: '非常',
  well: '好',
  too: '也/太',
  also: '也',
  always: '总是',
  often: '经常',
  sometimes: '有时',
  usually: '通常',
  never: '从不',
  now: '现在',
  here: '这里',
  there: '那里',
  where: '哪里',
  what: '什么',
  who: '谁',
  whose: '谁的',
  when: '什么时候',
  why: '为什么',
  how: '怎样',
};

/** 常见时间、地点、方式短语映射（在中文里需要前置到动词前） */
const ADVERBIAL_PHRASES: readonly [RegExp, string][] = [
  [/\bevery\s+day\b/i, '每天'],
  [/\bevery\s+morning\b/i, '每天早上'],
  [/\bevery\s+afternoon\b/i, '每天下午'],
  [/\bevery\s+evening\b/i, '每天晚上'],
  [/\bevery\s+week\b/i, '每周'],
  [/\bevery\s+year\b/i, '每年'],
  [/\blast\s+year\b/i, '去年'],
  [/\blast\s+month\b/i, '上个月'],
  [/\blast\s+week\b/i, '上周'],
  [/\blast\s+night\b/i, '昨晚'],
  [/\blast\s+sunday\b/i, '上周日'],
  [/\blast\s+saturday\b/i, '上周六'],
  [/\blast\s+weekend\b/i, '上周末'],
  [/\bnext\s+week\b/i, '下周'],
  [/\bnext\s+year\b/i, '明年'],
  [/\bon\s+sunday\s+morning\b/i, '在星期天早上'],
  [/\bon\s+sunday\b/i, '在星期天'],
  [/\bon\s+saturday\b/i, '在星期六'],
  [/\bon\s+monday\b/i, '在星期一'],
  [/\bin\s+the\s+morning\b/i, '在早上'],
  [/\bin\s+the\s+afternoon\b/i, '在下午'],
  [/\bin\s+the\s+evening\b/i, '在晚上'],
  [/\bat\s+night\b/i, '在夜晚'],
  [/\byesterday\b/i, '昨天'],
  [/\btomorrow\b/i, '明天'],
  [/\btoday\b/i, '今天'],
  [/\bnow\b/i, '现在'],
  [/\bon\s+foot\b/i, '步行'],
  [/\bby\s+bus\b/i, '乘公交车'],
  [/\bby\s+bike\b/i, '骑自行车'],
  [/\bby\s+car\b/i, '乘小汽车'],
  [/\bby\s+train\b/i, '乘火车'],
  [/\bby\s+plane\b/i, '乘飞机'],
  [/\bin\s+the\s+classroom\b/i, '在教室里'],
  [/\bin\s+the\s+music\s+room\b/i, '在音乐教室里'],
  [/\bin\s+the\s+art\s+room\b/i, '在美术教室里'],
  [/\bin\s+the\s+library\b/i, '在图书馆里'],
  [/\bin\s+the\s+park\b/i, '在公园里'],
  [/\bin\s+the\s+zoo\b/i, '在动物园里'],
  [/\bin\s+the\s+garden\b/i, '在花园里'],
  [/\bin\s+the\s+room\b/i, '在房间里'],
  [/\bin\s+the\s+hall\b/i, '在礼堂里'],
  [/\bin\s+the\s+sky\b/i, '在天空中'],
  [/\bin\s+the\s+tree\b/i, '在树上'],
  [/\bin\s+the\s+river\b/i, '在河里'],
  [/\bin\s+the\s+lake\b/i, '在湖里'],
  [/\bin\s+the\s+cup\b/i, '在杯子里'],
  [/\bin\s+the\s+box\b/i, '在盒子里'],
  [/\bin\s+the\s+bag\b/i, '在包里'],
  [/\bin\s+the\s+picture\b/i, '在图画里'],
  [/\bin\s+(?:our|my|the)\s+school\b/i, '在学校里'],
  [/\bin\s+(?:his|her|my|our|the)\s+class\b/i, '在班里'],
  [/\bon\s+the\s+playground\b/i, '在操场上'],
  [/\bon\s+the\s+table\b/i, '在桌子上'],
  [/\bon\s+the\s+desk\b/i, '在书桌上'],
  [/\bon\s+the\s+chair\b/i, '在椅子上'],
  [/\bon\s+the\s+bed\b/i, '在床上'],
  [/\bon\s+the\s+wall\b/i, '在墙上'],
  [/\bon\s+the\s+floor\b/i, '在地板上'],
  [/\bon\s+the\s+grass\b/i, '在草地上'],
  [/\bunder\s+the\s+tree\b/i, '在树下'],
  [/\bunder\s+the\s+desk\b/i, '在书桌下'],
  [/\bunder\s+the\s+chair\b/i, '在椅子下'],
  [/\bunder\s+the\s+bed\b/i, '在床下'],
  [/\bat\s+home\b/i, '在家里'],
  [/\bat\s+school\b/i, '在学校'],
  [/\btogether\b/i, '一起'],
];

/** 常见动宾/动词短语（按整体翻译避免一词多义错误） */
const VERB_PHRASES: readonly [RegExp, string][] = [
  [/^like\s+to\s+read\s+books$/i, '喜欢看书'],
  [/^like\s+reading\s+books$/i, '喜欢看书'],
  [/^read\s+books$/i, '看书'],
  [/^read\s+a\s+book$/i, '看一本书'],
  [/^reading\s+a\s+book$/i, '看一本书'],
  [/^go\s+to\s+school$/i, '去上学'],
  [/^goes\s+to\s+school$/i, '去上学'],
  [/^went\s+to\s+school$/i, '去了学校'],
  [/^go\s+home$/i, '回家'],
  [/^goes\s+home$/i, '回家'],
  [/^went\s+home$/i, '回了家'],
  [/^go\s+to\s+bed$/i, '去睡觉'],
  [/^get\s+up$/i, '起床'],
  [/^gets\s+up$/i, '起床'],
  [/^got\s+up$/i, '起了床'],
  [/^watch\s+tv$/i, '看电视'],
  [/^watches\s+tv$/i, '看电视'],
  [/^watched\s+tv$/i, '看了电视'],
  [/^watching\s+tv$/i, '看电视'],
  [/^play\s+football$/i, '踢足球'],
  [/^plays\s+football$/i, '踢足球'],
  [/^played\s+football$/i, '踢了足球'],
  [/^playing\s+football$/i, '踢足球'],
  [/^play\s+basketball$/i, '打篮球'],
  [/^playing\s+basketball$/i, '打篮球'],
  [/^play\s+the\s+piano$/i, '弹钢琴'],
  [/^playing\s+the\s+piano$/i, '弹钢琴'],
  [/^play\s+the\s+violin$/i, '拉小提琴'],
  [/^play\s+games$/i, '玩游戏'],
  [/^playing\s+games$/i, '玩游戏'],
  [/^speak\s+english\s+very\s+well$/i, '把英语说得很好'],
  [/^speaks\s+english\s+very\s+well$/i, '英语说得很好'],
  [/^speak\s+english$/i, '说英语'],
  [/^speaks\s+english$/i, '说英语'],
  [/^visit\s+the\s+great\s+wall$/i, '参观长城'],
  [/^visited\s+the\s+great\s+wall$/i, '参观了长城'],
  [/^visiting\s+the\s+great\s+wall$/i, '参观长城'],
  [/^have\s+a\s+party$/i, '举办聚会'],
  [/^had\s+a\s+party$/i, '举办了聚会'],
  [/^have\s+breakfast$/i, '吃早餐'],
  [/^have\s+lunch$/i, '吃午餐'],
  [/^have\s+dinner$/i, '吃晚餐'],
  [/^do\s+(?:my|his|her|our)\s+homework$/i, '做作业'],
  [/^did\s+(?:my|his|her|our)\s+homework$/i, '做了作业'],
  [/^doing\s+(?:my|his|her|our)\s+homework$/i, '做作业'],
  [/^clean\s+(?:my|his|her|our|the)\s+room$/i, '打扫房间'],
  [/^cleaned\s+(?:my|his|her|our|the)\s+room$/i, '打扫了房间'],
  [/^cleaning\s+(?:my|his|her|our|the)\s+room$/i, '打扫房间'],
  [/^went\s+to\s+the\s+zoo$/i, '去了动物园'],
  [/^go\s+to\s+the\s+zoo$/i, '去动物园'],
  [/^went\s+to\s+the\s+museum$/i, '去了博物馆'],
  [/^go\s+to\s+the\s+museum$/i, '去博物馆'],
  [/^went\s+to\s+the\s+park$/i, '去了公园'],
  [/^go\s+to\s+the\s+park$/i, '去公园'],
  [/^went\s+to\s+beijing$/i, '去了北京'],
  [/^go\s+to\s+beijing$/i, '去北京'],
];

function firstGloss(meaning: string | null | undefined): string | null {
  if (!meaning) return null;
  const items = splitMeaningParts(meaning).filter(
    (s) => /[\u4e00-\u9fff]/.test(s) && !s.includes('先听读音'),
  );
  return items[0] ?? null;
}

function lookupWordZh(
  word: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const clean = word.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
  if (!clean) return null;
  if (KID_WORD_GLOSS[clean]) return KID_WORD_GLOSS[clean]!;
  if (lookupMeaning) {
    const g = firstGloss(lookupMeaning(clean));
    if (g) return g;
  }
  return null;
}

/** 翻译名词短语（如 "a little brother" -> "一个小弟弟", "the yellow banana" -> "那根黄色的香蕉"） */
function translateNounPhrase(
  raw: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const text = raw.trim().replace(/[.?!]+$/, '').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const specialNouns: Record<string, string> = {
    'my family': '我的家庭',
    'a little brother': '一个小弟弟',
    'a little sister': '一个小妹妹',
    'my little brother': '我的小弟弟',
    'my little sister': '我的小妹妹',
    'the great wall': '长城',
    'a new dress': '一条新连衣裙',
    'some bread': '一些面包',
    'some juice': '一些果汁',
    'some apples': '一些苹果',
    'some water': '一些水',
    'some milk': '一些牛奶',
    'that one': '那一个',
    'this one': '这一个',
    'good football player': '优秀的足球运动员',
    'best football player': '最棒的足球运动员',
    'the best football player': '最棒的足球运动员',
    'the best book': '最好的书',
    'the yellow banana': '那根黄色的香蕉',
    'a yellow banana': '一根黄色的香蕉',
  };
  if (specialNouns[lower]) return specialNouns[lower]!;

  // 匹配限定词前缀
  const detMatch =
    /^(a|an|the|my|your|his|her|our|their|this|that|these|those|some|any|many|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i.exec(
      text,
    );

  let prefix = '';
  let rest = text;
  if (detMatch?.[1] && detMatch[2]) {
    const det = detMatch[1].toLowerCase();
    rest = detMatch[2].trim();
    const detMap: Record<string, string> = {
      a: '一个',
      an: '一个',
      the: '这个',
      my: '我的',
      your: '你的',
      his: '他的',
      her: '她的',
      our: '我们的',
      their: '他们的',
      this: '这个',
      that: '那个',
      these: '这些',
      those: '那些',
      some: '一些',
      any: '一些',
      many: '许多',
      one: '一个',
      two: '两个',
      three: '三个',
      four: '四个',
      five: '五个',
      six: '六个',
      seven: '七个',
      eight: '八个',
      nine: '九个',
      ten: '十个',
    };
    prefix = detMap[det] ?? '';
  }

  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;

  const parts: string[] = [];
  for (const w of words) {
    const zh = lookupWordZh(w, lookupMeaning);
    if (!zh) return null;
    parts.push(zh);
  }

  const headNoun = words[words.length - 1]!.toLowerCase();
  if (
    (prefix === '一个' || prefix.endsWith('个')) &&
    /^(doctor|teacher|nurse|driver|farmer|student|cook|worker|player)$/.test(headNoun)
  ) {
    prefix = prefix.replace(/个$/, '名');
  } else if (prefix.endsWith('个') && /^(bird|birds|cat|cats|dog|dogs|duck|ducks|monkey|tiger|lion|panda|rabbit)$/.test(headNoun)) {
    prefix = prefix.replace(/个$/, '只');
  } else if (prefix.endsWith('个') && /^(book|books)$/.test(headNoun)) {
    prefix = prefix.replace(/个$/, '本');
  } else if (prefix.endsWith('个') && /^(dress|skirt)$/.test(headNoun)) {
    prefix = prefix.replace(/个$/, '条');
  } else if (prefix === '这个') {
    prefix = '';
  }

  return `${prefix}${parts.join('')}`;
}

/** 翻译形容词表语（如 "red and sweet" -> "又红又甜", "tall" -> "很高"） */
function translatePredicateAdj(
  raw: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const text = raw.trim().replace(/^(very|so|too)\s+/i, '');
  const degMatch = /^(very|so|too)\s+/i.exec(raw.trim());
  const deg =
    degMatch?.[1]?.toLowerCase() === 'too'
      ? '太'
      : degMatch?.[1]
        ? '非常'
        : '';

  const andMatch = /^([a-z]+)\s+and\s+([a-z]+)$/i.exec(text);
  if (andMatch?.[1] && andMatch[2]) {
    const a1 = lookupWordZh(andMatch[1], lookupMeaning)?.replace(/的$/, '');
    const a2 = lookupWordZh(andMatch[2], lookupMeaning)?.replace(/的$/, '');
    if (a1 && a2) return `又${a1}又${a2}`;
  }

  if (/^[a-z]+$/i.test(text)) {
    const zh = lookupWordZh(text, lookupMeaning);
    if (zh && zh.endsWith('的')) {
      return `${deg || '很'}${zh.replace(/的$/, '')}`;
    }
  }
  return null;
}

/** 提取句中的时间/地点/方式状语，返回剩余主干和前置中文状语 */
function extractAdverbials(clause: string): { core: string; adverbialsZh: string } {
  let remaining = clause;
  const found: string[] = [];

  for (const [pattern, zh] of ADVERBIAL_PHRASES) {
    if (pattern.test(remaining)) {
      found.push(zh);
      remaining = remaining.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  return {
    core: remaining,
    adverbialsZh: found.join(''),
  };
}

/** 翻译动词+宾语核心谓语 */
function translateVerbPhrase(
  rawVp: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const vp = rawVp.trim();
  if (!vp) return null;

  for (const [pattern, zh] of VERB_PHRASES) {
    if (pattern.test(vp)) return zh;
  }

  // like to V + Obj / like V-ing + Obj
  const likeToMatch = /^(?:like|likes|love|loves|want|wants)\s+to\s+(.+)$/i.exec(vp);
  if (likeToMatch?.[1]) {
    const verbPrefix = /^want/i.test(vp) ? '想要' : '喜欢';
    const inner = translateVerbPhrase(likeToMatch[1], lookupMeaning);
    if (inner) return `${verbPrefix}${inner}`;
  }

  // 单一不及物动词（如 sing / singing / dancing / swim）
  if (/^[a-z]+$/i.test(vp)) {
    return lookupWordZh(vp, lookupMeaning);
  }

  // 动词 + 名词短语宾语（如 bought a new dress / eat some apples / likes apples）
  const parts = vp.split(/\s+/);
  if (parts.length >= 2) {
    const verbWord = parts[0]!;
    const objRaw = parts.slice(1).join(' ');
    const verbZh = lookupWordZh(verbWord, lookupMeaning);
    const objZh = translateNounPhrase(objRaw, lookupMeaning);
    if (verbZh && objZh) {
      return `${verbZh}${objZh}`;
    }
  }

  return null;
}

/**
 * 本地整句语法与句型翻译器：
 * 结合句型模板、时间/地点状语前置重排、系表结构、主谓宾结构，输出自然通顺的中文整句。
 */
export function matchHighConfidenceTemplate(
  sentence: string,
  lookupMeaning?: (word: string) => string | null,
): string | null {
  const key = normalizeSentenceKey(sentence);
  const exact = EXACT_SENTENCES[key];
  if (exact) return exact;

  // 去掉首尾标点，保留内部结构
  const isQuestion = key.endsWith('?');
  const isExclam = key.endsWith('!');
  const endPunct = isQuestion ? '？' : isExclam ? '！' : '。';
  const body = key
    .replace(/^[—\-–\s]+/, '')
    .replace(/[.?!]+$/, '')
    .trim();

  // 0. 单元标题 Unit N Title
  const unitMatch = /^unit\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i.exec(
    body,
  );
  if (unitMatch?.[1] && unitMatch[2]) {
    const numMap: Record<string, string> = {
      '1': '一',
      '2': '二',
      '3': '三',
      '4': '四',
      '5': '五',
      '6': '六',
      '7': '七',
      '8': '八',
      '9': '九',
      '10': '十',
      one: '一',
      two: '二',
      three: '三',
      four: '四',
      five: '五',
      six: '六',
      seven: '七',
      eight: '八',
      nine: '九',
      ten: '十',
    };
    const uNum = numMap[unitMatch[1].toLowerCase()] ?? unitMatch[1];
    const titleZh = translateNounPhrase(unitMatch[2], lookupMeaning);
    if (titleZh) return `第${uNum}单元：${titleZh}`;
  }

  // 1. 问答对话（如 "Can you swim? Yes, I can." / "Is this your pen? No, it's hers."）
  if (/^can you ([a-z]+)\?\s*[—\-–]?\s*yes,\s*i can$/i.test(key.replace(/[.!]+$/, ''))) {
    const vMatch = /^can you ([a-z]+)/i.exec(key);
    const vZh = vMatch?.[1] ? lookupWordZh(vMatch[1], lookupMeaning) : null;
    if (vZh) return `你会${vZh}吗？是的，我会。`;
  }

  // 2. My name is X. / I am N years old.
  const nameMatch = /^my name is ([a-z]+)$/i.exec(body);
  if (nameMatch?.[1]) {
    const name = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
    return `我的名字叫 ${name}。`;
  }

  const ageMatch =
    /^(?:i am|i'm) (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) years old$/i.exec(
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

  // 3. 祈使句：Look at X / Listen! S + V / Let's go to X
  const lookAtMatch = /^look at (.+)$/i.exec(body);
  if (lookAtMatch?.[1]) {
    const obj = translateNounPhrase(lookAtMatch[1], lookupMeaning);
    if (obj) return `看${obj}${endPunct}`;
  }

  const listenLeadMatch = /^(listen|look)[!,.]?\s+(.+)$/i.exec(body);
  if (listenLeadMatch?.[1] && listenLeadMatch[2]) {
    const leadZh = listenLeadMatch[1].toLowerCase() === 'listen' ? '听！' : '看！';
    const restZh = matchHighConfidenceTemplate(`${listenLeadMatch[2]}.`, lookupMeaning);
    if (restZh) return `${leadZh}${restZh}`;
  }

  const letsGoMatch = /^let(?:'s| us) go to ([a-z\s]+?)(?:\s+together)?$/i.exec(body);
  if (letsGoMatch?.[1]) {
    const together = /\btogether$/.test(body);
    const place = translateNounPhrase(letsGoMatch[1], lookupMeaning);
    if (place) return `我们${together ? '一起' : ''}去${place}吧！`;
  }

  // 4. There is / There are / There be + NP + 地点状语
  const thereMatch = /^there (?:is|are|be) (.+)$/i.exec(body);
  if (thereMatch?.[1] && !isQuestion) {
    const { core, adverbialsZh } = extractAdverbials(thereMatch[1]);
    const np = translateNounPhrase(core, lookupMeaning);
    if (np) {
      const loc = adverbialsZh ? adverbialsZh.replace(/^在/, '') : '这里';
      return `${loc}有${np}。`;
    }
  }

  // 5. 比较级：X is (adj-er / more adj) than Y
  const compMatch = /^(.+?)\s+is\s+(?:more\s+)?([a-z]+)\s+than\s+(.+)$/i.exec(body);
  if (compMatch?.[1] && compMatch[2] && compMatch[3]) {
    const subj = translateNounPhrase(compMatch[1], lookupMeaning);
    const adjRaw = compMatch[2].replace(/er$/i, '');
    const adj =
      lookupWordZh(compMatch[2], lookupMeaning)?.replace(/^更|的$/g, '') ??
      lookupWordZh(adjRaw, lookupMeaning)?.replace(/的$/, '');
    const target = translateNounPhrase(compMatch[3], lookupMeaning);
    if (subj && adj && target) {
      return `${subj}比${target}更${adj}。`;
    }
  }

  // 6. 特殊疑问句：Where / What + ...
  if (body === 'what is this' || body === "what's this") return '这是什么？';
  if (body === 'what is that' || body === "what's that") return '那是什么？';

  const whereIsMatch = /^where (?:is|are) (.+)$/i.exec(body);
  if (whereIsMatch?.[1] && isQuestion) {
    const obj = translateNounPhrase(whereIsMatch[1], lookupMeaning);
    if (obj) return `${obj}在哪里？`;
  }

  const doYouLikeMatch = /^do you like (.+)$/i.exec(body);
  if (doYouLikeMatch?.[1] && isQuestion) {
    const obj = translateNounPhrase(doYouLikeMatch[1], lookupMeaning);
    if (obj) return `你喜欢${obj}吗？`;
  }

  const isThisMatch = /^is (this|that) (.+)$/i.exec(body);
  if (isThisMatch?.[1] && isThisMatch[2] && isQuestion) {
    const dem = isThisMatch[1].toLowerCase() === 'this' ? '这' : '那';
    const obj = translateNounPhrase(isThisMatch[2], lookupMeaning);
    if (obj) return `${dem}是${obj}吗？`;
  }

  // 7. 一般陈述句：提取时间/地点/方式状语后，匹配「系表结构」或「主谓宾结构」
  if (!isQuestion) {
    const { core, adverbialsZh } = extractAdverbials(body);

    // 7a. 进行时：Subject + am/is/are + V-ing (+ Obj)
    const progMatch = /^(.+?)\s+(?:am|is|are)\s+([a-z]+ing(?:\s+.+)?)$/i.exec(core);
    if (progMatch?.[1] && progMatch[2]) {
      const subj = translateNounPhrase(progMatch[1], lookupMeaning);
      const vp = translateVerbPhrase(progMatch[2], lookupMeaning);
      if (subj && vp) {
        return `${subj}${adverbialsZh}正在${vp}${endPunct}`;
      }
    }

    // 7b. 系表结构：Subject + am/is/are + NP / Adj
    const copulaMatch = /^(.+?)\s+(?:am|is|are)\s+(.+)$/i.exec(core);
    if (copulaMatch?.[1] && copulaMatch[2]) {
      const rawSubj = copulaMatch[1].trim().toLowerCase();
      const subj =
        rawSubj === 'this'
          ? '这'
          : rawSubj === 'that'
            ? '那'
            : translateNounPhrase(copulaMatch[1], lookupMeaning);
      const predAdj = translatePredicateAdj(copulaMatch[2], lookupMeaning);
      if (subj && predAdj) {
        return `${subj}${adverbialsZh}${predAdj}${endPunct}`;
      }
      const predNp = translateNounPhrase(copulaMatch[2], lookupMeaning);
      if (subj && predNp) {
        return `${subj}${adverbialsZh}是${predNp}${endPunct}`;
      }
    }

    // 7c. 情态动词/否定结构：Subject + can / can't / don't / doesn't / didn't + VP
    const modalMatch =
      /^(.+?)\s+(can|cannot|can't|do not|don't|does not|doesn't|did not|didn't|will)\s+(.+)$/i.exec(
        core,
      );
    if (modalMatch?.[1] && modalMatch[2] && modalMatch[3]) {
      const subj = translateNounPhrase(modalMatch[1], lookupMeaning);
      const aux = modalMatch[2].toLowerCase();
      const auxZh =
        aux === 'can'
          ? '会'
          : aux === 'will'
            ? '将要'
            : aux === 'cannot' || aux === "can't"
              ? '不会'
              : aux === 'did not' || aux === "didn't"
                ? '没有'
                : '不';
      const vp = translateVerbPhrase(modalMatch[3], lookupMeaning);
      if (subj && vp) {
        return `${subj}${adverbialsZh}${auxZh}${vp}${endPunct}`;
      }
    }

    // 7d. 通用主谓宾结构：Subject + VP
    const words = core.split(/\s+/);
    for (let splitIdx = 1; splitIdx <= Math.min(3, words.length - 1); splitIdx += 1) {
      const subjRaw = words.slice(0, splitIdx).join(' ');
      const vpRaw = words.slice(splitIdx).join(' ');
      const subj = translateNounPhrase(subjRaw, lookupMeaning);
      if (!subj) continue;
      const vp = translateVerbPhrase(vpRaw, lookupMeaning);
      if (vp) {
        return `${subj}${adverbialsZh}${vp}${endPunct}`;
      }
    }
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
 * 为句子提取句内重点实词的中文释义列表
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

    const meaning = lookupWordZh(clean, lookupMeaning);
    if (!meaning) continue;

    seen.add(lower);
    items.push({ word: clean, meaning });
    if (items.length >= 6) break;
  }

  return items;
}
