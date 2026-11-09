export interface NormalizedPoint {
  x: number;
  y: number;
}

export type NormalizedQuad = [
  NormalizedPoint,
  NormalizedPoint,
  NormalizedPoint,
  NormalizedPoint,
];

function clamp01(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 1e6) / 1e6;
}

/**
 * 将归一化 0–1 词框适度外扩，增大手指在书页上的点按热区。
 * 顶点顺序固定为：左上、右上、右下、左下。
 */
export function expandQuad(
  quad: NormalizedQuad,
  padX = 0.0035,
  padY = 0.004,
): NormalizedQuad {
  const [tl, tr, br, bl] = quad;
  return [
    { x: clamp01(tl.x - padX), y: clamp01(tl.y - padY) },
    { x: clamp01(tr.x + padX), y: clamp01(tr.y - padY) },
    { x: clamp01(br.x + padX), y: clamp01(br.y + padY) },
    { x: clamp01(bl.x - padX), y: clamp01(bl.y + padY) },
  ];
}

export function toSvgPoints(quad: NormalizedQuad): string {
  return quad.map((point) => `${point.x},${point.y}`).join(' ');
}
