import assert from 'node:assert/strict';
import test from 'node:test';
import { formatKidExample, formatKidMeaning, lookupZhSense, type ZhDict } from './sense.ts';
import { lemmaCandidates } from './lexicon.ts';

test('play 取名词和动词各一条，不带网络义', () => {
  const meaning = formatKidMeaning(
    'n. 游戏, 比赛, 运动\nv. 玩；演奏；播放\n[网络] 播放；话剧',
  );
  assert.equal(meaning, '游戏；玩');
});

test('apple 去掉被包含的重复义项', () => {
  assert.equal(formatKidMeaning('n. 苹果, 苹果树'), '苹果');
});

test('together 只取第一个常用义', () => {
  assert.equal(formatKidMeaning('adv. 一起, 共同, 彼此'), '一起');
});

test('unit 权威词典第一义是单位，课本义由词卡覆盖', () => {
  assert.equal(formatKidMeaning('n. 单位, 分队, 部队, 单元'), '单位');
});

test('like 名词性以外补上动词义', () => {
  assert.equal(formatKidMeaning('a. 相似的, 同样的\nvt. 喜欢, 愿意, 想'), '相似的；喜欢');
});

test('father 丢掉当父亲这类派生义', () => {
  assert.equal(
    formatKidMeaning('n. 父亲, 祖先, 长辈, 神父, 创始者\nvt. 当...的父亲, 保护, 创作, 发明, 培养'),
    '父亲',
  );
});

test('名词英文释义能收成例句', () => {
  assert.equal(formatKidExample('apple', 'n. a round fruit with red skin'), 'Apple is a round fruit with red skin.');
});

test('变形词沿指针查到原形', () => {
  const dict: ZhDict = new Map([
    ['play', { meaning: '游戏；玩', example: 'We play a game.', phonetic: 'pleɪ' }],
    ['played', 'play'],
  ]);
  const hit = lookupZhSense(dict, 'played', lemmaCandidates('played'));
  assert.equal(hit?.meaning, '游戏；玩');
});
