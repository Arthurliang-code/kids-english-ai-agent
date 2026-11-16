import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrWord, Quad } from '@kea/shared-types';
import {
  buildSentences,
  buildSentenceWordBreakdown,
  findSentenceForWord,
  matchHighConfidenceTemplate,
} from './sentence.ts';

function makeQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function makeWord(
  id: string,
  lineId: string,
  indexInLine: number,
  text: string,
  rawText: string,
  quad: Quad,
  lexiconHit = true,
  confidence = 0.92,
): OcrWord {
  return {
    id,
    text,
    rawText,
    confidence,
    quad,
    lineId,
    indexInLine,
    lexiconHit,
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
  };
}

void test('buildSentences 能把同一段跨行折行的句子合并为完整一句', () => {
  const words: OcrWord[] = [
    makeWord('l0-w0', 'l0', 0, 'We', 'We', makeQuad(0.1, 0.1, 0.18, 0.14)),
    makeWord('l0-w1', 'l0', 1, 'play', 'play', makeQuad(0.2, 0.1, 0.3, 0.14)),
    makeWord('l0-w2', 'l0', 2, 'games', 'games', makeQuad(0.32, 0.1, 0.45, 0.14)),
    makeWord('l1-w0', 'l1', 0, 'in', 'in', makeQuad(0.1, 0.16, 0.16, 0.2)),
    makeWord('l1-w1', 'l1', 1, 'the', 'the', makeQuad(0.18, 0.16, 0.25, 0.2)),
    makeWord('l1-w2', 'l1', 2, 'park', 'park.', makeQuad(0.27, 0.16, 0.38, 0.2)),
  ];

  const sentences = buildSentences(words);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0]?.text, 'We play games in the park.');
  assert.equal(sentences[0]?.trusted, true);
  assert.deepEqual(sentences[0]?.wordIds, ['l0-w0', 'l0-w1', 'l0-w2', 'l1-w0', 'l1-w1', 'l1-w2']);

  const found = findSentenceForWord(sentences, 'l1-w2');
  assert.equal(found?.id, 's0');
});

void test('buildSentences 遇到句末标点不跨行误合，且过滤单字噪声行', () => {
  const words: OcrWord[] = [
    makeWord('l0-w0', 'l0', 0, 'I', 'I', makeQuad(0.1, 0.1, 0.14, 0.14)),
    makeWord('l0-w1', 'l0', 1, 'like', 'like', makeQuad(0.16, 0.1, 0.24, 0.14)),
    makeWord('l0-w2', 'l0', 2, 'apples', 'apples.', makeQuad(0.26, 0.1, 0.38, 0.14)),
    makeWord('l1-w0', 'l1', 0, 'x', 'x', makeQuad(0.8, 0.5, 0.85, 0.54), false, 0.3),
  ];

  const sentences = buildSentences(words);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0]?.trusted, true);
  assert.equal(sentences[1]?.trusted, false);
  assert.equal(findSentenceForWord(sentences, 'l1-w0'), null);
});

void test('matchHighConfidenceTemplate 命中高频小学句型并结合本地词义输出自然中文', () => {
  const dict: Record<string, string> = {
    apple: '苹果；果树',
    apples: '苹果',
    park: '公园',
    book: '书；本子',
  };
  const lookup = (w: string) => dict[w.toLowerCase()] ?? null;

  assert.equal(matchHighConfidenceTemplate('How are you?', lookup), '你好吗？');
  assert.equal(matchHighConfidenceTemplate('I like apples.', lookup), '我喜欢苹果。');
  assert.equal(matchHighConfidenceTemplate("I don't like apples.", lookup), '我不喜欢苹果。');
  assert.equal(
    matchHighConfidenceTemplate("Let's go to the park together!", lookup),
    '我们一起去公园吧！',
  );
  assert.equal(matchHighConfidenceTemplate('Where is my book?', lookup), '我的书在哪里？');
  // 复杂陌生句不强行硬凑，返回 null 交由大模型或诚实词义拆解
  assert.equal(
    matchHighConfidenceTemplate(
      'The girl in the red dress is reading a book under the tree.',
      lookup,
    ),
    null,
  );
});

void test('buildSentenceWordBreakdown 提取句中重点实词词义', () => {
  const dict: Record<string, string> = {
    girl: '女孩；姑娘',
    red: '红色的',
    dress: '连衣裙',
    reading: '阅读；读书',
    book: '书；课本',
  };
  const breakdown = buildSentenceWordBreakdown(
    ['The', 'girl', 'in', 'the', 'red', 'dress', 'is', 'reading', 'a', 'book'],
    (w) => dict[w.toLowerCase()] ?? null,
  );

  assert.deepEqual(breakdown, [
    { word: 'girl', meaning: '女孩' },
    { word: 'red', meaning: '红色的' },
    { word: 'dress', meaning: '连衣裙' },
    { word: 'reading', meaning: '阅读' },
    { word: 'book', meaning: '书' },
  ]);
});
