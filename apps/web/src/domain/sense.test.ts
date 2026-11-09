import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatKidExample,
  formatKidMeaning,
  lookupZhSense,
  mergeSenses,
  type ZhDict,
} from './sense.ts';
import { lemmaCandidates } from './lexicon.ts';

test('play 能列出游戏、比赛和玩', () => {
  const meaning = formatKidMeaning(
    'n. 游戏, 比赛, 运动\nv. 玩；演奏；播放\n[网络] 播放；话剧',
  );
  assert.equal(meaning, '游戏；比赛；运动；玩');
});

test('apple 去掉被包含的重复义项', () => {
  assert.equal(formatKidMeaning('n. 苹果, 苹果树'), '苹果');
});

test('together 能列出一起和共同', () => {
  assert.equal(formatKidMeaning('adv. 一起, 共同, 彼此'), '一起；共同；彼此');
});

test('unit 跳过部队义，保留单位和单元', () => {
  assert.equal(formatKidMeaning('n. 单位, 分队, 部队, 单元'), '单位；单元');
});

test('like 同时保留形容词和动词义', () => {
  assert.equal(formatKidMeaning('a. 相似的, 同样的\nvt. 喜欢, 愿意, 想'), '相似的；同样的；喜欢；愿意');
});

test('father 丢掉当父亲这类派生义', () => {
  assert.equal(
    formatKidMeaning('n. 父亲, 祖先, 长辈, 神父, 创始者\nvt. 当...的父亲, 保护, 创作, 发明, 培养'),
    '父亲；祖先；长辈',
  );
});

test('名词英文释义能收成例句', () => {
  assert.equal(formatKidExample('apple', 'n. a round fruit with red skin'), 'Apple is a round fruit with red skin.');
});

test('戏剧义的英文释义不会拿来当例句', () => {
  const example = formatKidExample(
    'play',
    'n. a dramatic work intended for performance by actors on a stage\\nn. a theatrical performance of a drama\\nn. a preset plan of action in team sports',
  );
  assert.equal(example, '');
});

test('词卡和词典能拼成更丰富的解释和例句', () => {
  const merged = mergeSenses(
    'apple',
    { meaning: '苹果', example: 'I eat an apple after school.' },
    {
      meaning: '苹果',
      example: 'Apple is a fruit with red or yellow or green skin.',
      phonetic: "'æpl",
    },
  );
  assert.equal(merged.meaning, '苹果');
  assert.match(merged.example, /I eat an apple/);
  assert.match(merged.example, /fruit/);
  assert.equal(merged.phonetic, "'æpl");
});

test('变形词沿指针查到原形', () => {
  const dict: ZhDict = new Map([
    ['play', { meaning: '游戏；玩', example: 'We play a game.', phonetic: 'pleɪ' }],
    ['played', 'play'],
  ]);
  const hit = lookupZhSense(dict, 'played', lemmaCandidates('played'));
  assert.equal(hit?.meaning, '游戏；玩');
});
