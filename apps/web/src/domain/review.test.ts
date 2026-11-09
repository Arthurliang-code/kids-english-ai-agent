import assert from 'node:assert/strict';
import test from 'node:test';
import { dueItems, grade, newItem, parseVocabExport, todayISO } from './review.ts';

test('记住了之后按新阶段的间隔推迟', () => {
  const today = '2026-11-09';
  const first = grade(newItem('apple', today), true, today);
  assert.deepEqual(first, { word: 'apple', stage: 1, due: '2026-11-10' });
  const second = grade(first, true, '2026-11-10');
  assert.equal(second.stage, 2);
  assert.equal(second.due, '2026-11-13');
});

test('没记住会降级，最低停在当天', () => {
  const today = '2026-11-09';
  const again = grade(newItem('book', today), false, today);
  assert.deepEqual(again, { word: 'book', stage: 0, due: today });
});

test('每天最多列出 20 个到期词，先到期、阶段低的在前', () => {
  const today = '2026-11-09';
  const items = [
    { word: 'late', stage: 0, due: '2026-11-10' },
    { word: 'hard', stage: 0, due: '2026-11-09' },
    { word: 'easy', stage: 3, due: '2026-11-09' },
  ];
  assert.deepEqual(
    dueItems(items, today).map((item) => item.word),
    ['hard', 'easy'],
  );
});

test('导出文件可以原样导回', () => {
  const items = [newItem('cat', todayISO(new Date(2026, 10, 9)))];
  const parsed = parseVocabExport({ version: 1, items });
  assert.deepEqual(parsed, items);
  assert.equal(parseVocabExport({ version: 2, items }), null);
});
