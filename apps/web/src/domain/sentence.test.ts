import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrWord, Quad } from '@kea/shared-types';
import {
  buildSentences,
  buildSentenceWordBreakdown,
  findSentenceForWord,
  matchHighConfidenceTemplate,
} from './sentence.ts';
import { recoverPronounI } from './text.ts';

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

void test('buildSentences 同横行碎片合并且大标题与题号行不粘连，支持竖线恢复为 I', () => {
  assert.equal(recoverPronounI('|', 'have'), true);
  assert.equal(recoverPronounI('|', 'Zzons'), false);

  const lines = [
    { id: 'l0', text: 'Unit 3 My Family', confidence: 0.94, quad: makeQuad(0.1, 0.08, 0.45, 0.14) },
    { id: 'l1', text: 'This is my family.', confidence: 0.95, quad: makeQuad(0.1, 0.18, 0.4, 0.22) },
    { id: 'l2', text: '2. They are', confidence: 0.95, quad: makeQuad(0.1, 0.28, 0.24, 0.315) },
    {
      id: 'l3',
      text: 'cleaning the classroom. (BASES)',
      confidence: 0.92,
      quad: makeQuad(0.25, 0.275, 0.62, 0.312),
    },
    { id: 'l4', text: 'B: I went with my sister.', confidence: 0.95, quad: makeQuad(0.1, 0.36, 0.48, 0.395) },
  ];

  const words: OcrWord[] = [
    makeWord('l0-w0', 'l0', 0, 'Unit', 'Unit', makeQuad(0.1, 0.08, 0.2, 0.14)),
    makeWord('l0-w1', 'l0', 1, 'My', 'My', makeQuad(0.22, 0.08, 0.3, 0.14)),
    makeWord('l0-w2', 'l0', 2, 'Family', 'Family', makeQuad(0.32, 0.08, 0.45, 0.14)),

    makeWord('l1-w0', 'l1', 0, 'This', 'This', makeQuad(0.1, 0.18, 0.18, 0.22)),
    makeWord('l1-w1', 'l1', 1, 'is', 'is', makeQuad(0.2, 0.18, 0.24, 0.22)),
    makeWord('l1-w2', 'l1', 2, 'my', 'my', makeQuad(0.26, 0.18, 0.31, 0.22)),
    makeWord('l1-w3', 'l1', 3, 'family', 'family.', makeQuad(0.32, 0.18, 0.4, 0.22)),

    makeWord('l2-w0', 'l2', 0, 'They', 'They', makeQuad(0.14, 0.28, 0.2, 0.315)),
    makeWord('l2-w1', 'l2', 1, 'are', 'are', makeQuad(0.21, 0.28, 0.24, 0.315)),

    makeWord('l3-w0', 'l3', 0, 'cleaning', 'cleaning', makeQuad(0.25, 0.275, 0.36, 0.312)),
    makeWord('l3-w1', 'l3', 1, 'the', 'the', makeQuad(0.37, 0.275, 0.41, 0.312)),
    makeWord('l3-w2', 'l3', 2, 'classroom', 'classroom.', makeQuad(0.42, 0.275, 0.54, 0.312)),
    makeWord('l3-w3', 'l3', 3, 'BASES', '(BASES)', makeQuad(0.55, 0.275, 0.62, 0.312), true, 0.65),

    makeWord('l4-w0', 'l4', 0, 'B', 'B:', makeQuad(0.1, 0.36, 0.13, 0.395)),
    makeWord('l4-w1', 'l4', 1, 'I', 'I', makeQuad(0.14, 0.36, 0.16, 0.395)),
    makeWord('l4-w2', 'l4', 2, 'went', 'went', makeQuad(0.17, 0.36, 0.23, 0.395)),
    makeWord('l4-w3', 'l4', 3, 'with', 'with', makeQuad(0.24, 0.36, 0.3, 0.395)),
    makeWord('l4-w4', 'l4', 4, 'my', 'my', makeQuad(0.31, 0.36, 0.36, 0.395)),
    makeWord('l4-w5', 'l4', 5, 'sister', 'sister.', makeQuad(0.37, 0.36, 0.48, 0.395)),
  ];

  const sents = buildSentences(words, lines);
  assert.deepEqual(
    sents.filter((s) => s.trusted).map((s) => s.text),
    [
      'Unit My Family.',
      'This is my family.',
      'They are cleaning the classroom.',
      'I went with my sister.',
    ],
  );
});
