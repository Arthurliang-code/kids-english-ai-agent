import assert from 'node:assert/strict';
import test from 'node:test';
import { pickBestEnglishVoice, type VoiceLike } from './voice.ts';

void test('pickBestEnglishVoice 优先选择英式自然音色并避开搞怪合成音色', () => {
  const voices: VoiceLike[] = [
    { name: 'Reed', lang: 'en-US' },
    { name: 'Fred', lang: 'en-US' },
    { name: 'Grandpa', lang: 'en-GB' },
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true },
  ];

  const uk = pickBestEnglishVoice(voices, 'uk');
  assert.equal(uk?.name, 'Daniel');

  const us = pickBestEnglishVoice(voices, 'us');
  assert.equal(us?.name, 'Samantha');
});

void test('pickBestEnglishVoice 在同口音下优先选择 Enhanced / Natural 高品质音色', () => {
  const voices: VoiceLike[] = [
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Samantha (Enhanced)', lang: 'en-US', localService: true },
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Microsoft Sonia Online (Natural)', lang: 'en-GB', localService: false },
  ];

  assert.equal(pickBestEnglishVoice(voices, 'us')?.name, 'Samantha (Enhanced)');
  assert.equal(
    pickBestEnglishVoice(voices, 'uk')?.name,
    'Microsoft Sonia Online (Natural)',
  );
});
