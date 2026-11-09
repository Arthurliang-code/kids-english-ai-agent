/**
 * 词库校验：识别结果必须先过英文词库，词库外的词不直接当作可教学内容。
 *
 * 词表来自系统词典，只有原形；试卷和绘本里大量是变形（played / games / friends）
 * 与缩写（I'd / that's）。实测加入词形还原后，可信词覆盖从 72.8% 提升到 76.2%，
 * 精确率只从 97.3% 降到 96.7%，所以查不到原形时再按常见词尾还原一次。
 *
 * 当前词表是 M1 验证用的通用词典；正式版应换成内容包下发的
 * 「儿童核心词 3000 + 教材词 + 通用词典」分层词库。
 */
let cache: Promise<Set<string> | null> | null = null;

export function loadLexicon(): Promise<Set<string> | null> {
  cache ??= (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}lexicon/en-words.txt.gz`);
      if (!response.ok) return null;

      const bytes = new Uint8Array(await response.arrayBuffer());
      // 开发服务器会原样给出 gzip；预览和部分静态托管会按 .gz 加上 Content-Encoding，
      // 这时 fetch 已经解压，正文以字母开头。两种都要能读。
      const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = gzip
        ? await new Response(
            new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).text()
        : new TextDecoder().decode(bytes);
      return new Set(text.split('\n'));
    } catch {
      return null;
    }
  })();

  return cache;
}

/** 缩写形式：I'd / that's / doesn't / we're … */
const CONTRACTION = /^(i|you|he|she|it|we|they|that|what|who|there|here|let|don|doesn|didn|isn|aren|wasn|weren|can|won|wouldn|shouldn|couldn|haven|hasn|hadn)['’](s|t|d|m|re|ll|ve)$/;

function isDoubleConsonant(word: string, endIndex: number): boolean {
  const prev = word[endIndex - 2];
  return prev !== undefined && prev === word[endIndex - 1];
}

/** 生成可能对应的词库原形，顺序按命中概率从高到低 */
function candidates(word: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length >= 2) out.push(value);
  };

  if (word.endsWith("'s") || word.endsWith('’s')) push(word.slice(0, -2));
  if (word.endsWith('ies')) push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) push(word.slice(0, -2));
  if (word.endsWith('s')) push(word.slice(0, -1));

  if (word.endsWith('ed')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
    if (isDoubleConsonant(word, word.length - 2)) push(word.slice(0, -3));
  }

  if (word.endsWith('ing')) {
    push(word.slice(0, -3));
    push(`${word.slice(0, -3)}e`);
    if (isDoubleConsonant(word, word.length - 3)) push(word.slice(0, -4));
  }

  if (word.endsWith('er') || word.endsWith('ly')) push(word.slice(0, -2));
  if (word.endsWith('est')) push(word.slice(0, -3));

  const contraction = CONTRACTION.exec(word);
  if (contraction?.[1]) push(contraction[1]);

  return out;
}

/** 原形 + 常见变形还原，供词库和释义共用。 */
export function lemmaCandidates(word: string): string[] {
  const lower = word.toLowerCase();
  return [lower, ...candidates(lower)];
}

export function lookupWord(lexicon: Set<string> | null, word: string): boolean {
  // 词库不可用时不做判定，避免把所有词都误标为可疑
  if (!lexicon) return true;
  return lemmaCandidates(word).some((candidate) => lexicon.has(candidate));
}
