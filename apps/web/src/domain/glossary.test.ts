import assert from 'node:assert/strict';
import test from 'node:test';
import { findGlossaryEntry } from './glossary.ts';
import { lemmaCandidates } from './lexicon.ts';

const entries = [
  { word: 'play', meaning: '玩', example: 'We play in the garden.' },
  { word: 'father', meaning: '爸爸', example: 'Father walks with me.' },
];

test('played 能命中 play 的释义', () => {
  const hit = findGlossaryEntry(entries, 'played', lemmaCandidates('played'));
  assert.equal(hit?.meaning, '玩');
});

test('Father 不区分大小写', () => {
  const hit = findGlossaryEntry(entries, 'Father', lemmaCandidates('Father'));
  assert.equal(hit?.meaning, '爸爸');
});
