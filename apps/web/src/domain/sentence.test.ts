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

void test('buildSentences 遇到句末标点不跨行误合，且过滤单字噪声与单选题选项后缀', () => {
  const words: OcrWord[] = [
    makeWord('l0-w0', 'l0', 0, 'I', 'I', makeQuad(0.1, 0.1, 0.14, 0.14)),
    makeWord('l0-w1', 'l0', 1, 'like', 'like', makeQuad(0.16, 0.1, 0.24, 0.14)),
    makeWord('l0-w2', 'l0', 2, 'apples', 'apples.', makeQuad(0.26, 0.1, 0.38, 0.14)),
    makeWord('l0-w3', 'l0', 3, 'A', 'A.', makeQuad(0.42, 0.1, 0.46, 0.14)),
    makeWord('l0-w4', 'l0', 4, 'go', 'go', makeQuad(0.48, 0.1, 0.54, 0.14)),
    makeWord('l1-w0', 'l1', 0, 'x', 'x', makeQuad(0.8, 0.5, 0.85, 0.54), false, 0.3),
  ];

  const sentences = buildSentences(words);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0]?.text, 'I like apples.');
  assert.equal(sentences[0]?.trusted, true);
  assert.equal(findSentenceForWord(sentences, 'l1-w0'), null);
});

void test('matchHighConfidenceTemplate 把课本样张与常见主谓宾/系表/状语后置句译为自然中文', () => {
  const dict: Record<string, string> = {
    apple: '苹果；果树',
    apples: '苹果',
    park: '公园',
    book: '书；本子',
  };
  const lookup = (w: string) => dict[w.toLowerCase()] ?? null;

  assert.equal(matchHighConfidenceTemplate('Unit 3 My Family.', lookup), '第三单元：我的家庭');
  assert.equal(matchHighConfidenceTemplate('This is my family.', lookup), '这是我的家庭。');
  assert.equal(matchHighConfidenceTemplate('My father is a doctor.', lookup), '我的爸爸是一名医生。');
  assert.equal(matchHighConfidenceTemplate('My mother is a teacher.', lookup), '我的妈妈是一名老师。');
  assert.equal(matchHighConfidenceTemplate('I have a little brother.', lookup), '我有一个小弟弟。');
  assert.equal(
    matchHighConfidenceTemplate('We like to read books together.', lookup),
    '我们喜欢一起看书。',
  );
  assert.equal(
    matchHighConfidenceTemplate('The apple is red and sweet.', lookup),
    '这个苹果又红又甜。',
  );
  assert.equal(
    matchHighConfidenceTemplate('Look at the yellow banana.', lookup),
    '看那根黄色的香蕉。',
  );
  assert.equal(
    matchHighConfidenceTemplate('She goes to school on foot every day.', lookup),
    '她每天步行去上学。',
  );
  assert.equal(
    matchHighConfidenceTemplate('Listen! The children are singing in the classroom.', lookup),
    '听！孩子们在教室里正在唱歌。',
  );
  assert.equal(
    matchHighConfidenceTemplate('We visited the Great Wall last year.', lookup),
    '我们去年参观了长城。',
  );
  assert.equal(
    matchHighConfidenceTemplate('She bought a new dress yesterday.', lookup),
    '她昨天买了一条新连衣裙。',
  );
  assert.equal(
    matchHighConfidenceTemplate('There are five birds in the tree.', lookup),
    '树上有五只鸟。',
  );
  assert.equal(
    matchHighConfidenceTemplate('My bag is heavier than yours.', lookup),
    '我的包比你的更重。',
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
    { word: 'reading', meaning: '读书' },
    { word: 'book', meaning: '书' },
  ]);
});
