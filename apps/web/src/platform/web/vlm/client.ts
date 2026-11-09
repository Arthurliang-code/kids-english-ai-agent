import type { VlmReview, VlmUncertain, VlmWord } from '@kea/shared-types';

/**
 * 云端语义复核客户端。
 *
 * 浏览器不直接持有模型密钥：请求发到同源的 /api/vlm-review，
 * 本地由 Vite 开发中间件代转（见 apps/web/vite.config.ts），
 * 正式环境由 CloudBase 云函数承接。§ 技术设计 5.4
 */

/** 长边压到 1600 再上传：实测这一档 VLM 词表已经全对，再大只是多花 token */
export const REVIEW_MAX_EDGE = 1600;

interface ReviewResponse {
  model: string;
  level: string | null;
  words: VlmWord[];
  uncertain: VlmUncertain[];
  usage?: { total_tokens?: number } | null;
  latencyMs?: number;
}

function endpoint(): string {
  return import.meta.env.VITE_VLM_ENDPOINT ?? '/api/vlm-review';
}

export async function reviewPage(imageDataUrl: string): Promise<VlmReview> {
  const started = performance.now();
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl }),
  });

  const payload = (await response.json().catch(() => null)) as (ReviewResponse & { error?: string }) | null;

  if (!response.ok || !payload) {
    const reason = payload?.error ?? `HTTP ${response.status}`;
    throw new Error(`云端复核失败：${reason}`);
  }

  return {
    model: payload.model,
    level: payload.level ?? null,
    words: payload.words ?? [],
    uncertain: payload.uncertain ?? [],
    latencyMs: payload.latencyMs ?? performance.now() - started,
    totalTokens: payload.usage?.total_tokens ?? null,
  };
}
