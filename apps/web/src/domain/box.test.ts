import assert from 'node:assert/strict';
import test from 'node:test';
import { expandQuad, toSvgPoints, type NormalizedQuad } from './box.ts';

test('expandQuad 向四周适度外扩词框热区', () => {
  const quad: NormalizedQuad = [
    { x: 0.2, y: 0.3 },
    { x: 0.3, y: 0.3 },
    { x: 0.3, y: 0.35 },
    { x: 0.2, y: 0.35 },
  ];
  const expanded = expandQuad(quad, 0.01, 0.02);
  assert.deepEqual(expanded, [
    { x: 0.19, y: 0.28 },
    { x: 0.31, y: 0.28 },
    { x: 0.31, y: 0.37 },
    { x: 0.19, y: 0.37 },
  ]);
});

test('expandQuad 在贴边词框上不会超出 0..1 边界', () => {
  const quad: NormalizedQuad = [
    { x: 0.001, y: 0.002 },
    { x: 0.999, y: 0.002 },
    { x: 0.999, y: 0.998 },
    { x: 0.001, y: 0.998 },
  ];
  const expanded = expandQuad(quad, 0.01, 0.01);
  assert.deepEqual(expanded, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
  assert.equal(toSvgPoints(expanded), '0,0 1,0 1,1 0,1');
});

