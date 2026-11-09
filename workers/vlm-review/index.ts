import { VLM_PROMPT } from './prompt';

interface Env {
  DEEPSEEK_API_KEY?: string;
  VLM_MODEL?: string;
  VLM_BASE_URL?: string;
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== 'POST') return json(405, { error: '只支持 POST' });
    if (!env.DEEPSEEK_API_KEY) return json(501, { error: '未配置 DEEPSEEK_API_KEY' });

    let image: unknown;
    try {
      image = (await request.json() as { image?: unknown }).image;
    } catch {
      return json(400, { error: '请求体不是合法 JSON' });
    }
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return json(400, { error: '缺少 image（data URL）' });
    }

    const model = env.VLM_MODEL || 'deepseek-flash';
    const baseUrl = (env.VLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    const started = Date.now();
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VLM_PROMPT },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    const payload = (await upstream.json().catch(() => null)) as
      | {
          choices?: { message?: { content?: string } }[];
          usage?: { total_tokens?: number };
          error?: { message?: string };
        }
      | null;

    if (!upstream.ok || !payload) {
      return json(502, { error: payload?.error?.message ?? `上游返回 ${upstream.status}` });
    }

    const content = payload.choices?.[0]?.message?.content ?? '';
    const jsonText = content.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
    let parsed: { level?: string; words?: unknown; uncertain?: unknown };
    try {
      parsed = JSON.parse(jsonText) as typeof parsed;
    } catch {
      return json(502, { error: `模型输出不是 JSON：${jsonText.slice(0, 160)}` });
    }

    const words = Array.isArray(parsed.words)
      ? parsed.words
          .filter((word): word is { text: string; teach?: boolean } => {
            return typeof (word as { text?: unknown })?.text === 'string';
          })
          .map((word) => ({ text: word.text, teach: word.teach !== false }))
      : [];

    return json(200, {
      model,
      level: typeof parsed.level === 'string' ? parsed.level : null,
      words,
      uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : [],
      usage: payload.usage ?? null,
      latencyMs: Date.now() - started,
    });
  },
};
