import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { pwaPlugin } from './pwa-plugin.ts';
import { VLM_PROMPT } from '../../workers/vlm-review/prompt.ts';

interface VlmPluginOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

function vlmReviewPlugin({ apiKey, model, baseUrl }: VlmPluginOptions): Plugin {
  return {
    name: 'kea-vlm-review',
    apply: 'serve',
    configureServer(server) {
      // 密钥只存在于开发服务器进程里，不会打进前端产物
      server.middlewares.use('/api/vlm-review', (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        void (async () => {
          if (req.method !== 'POST') {
            reply(405, { error: '只支持 POST' });
            return;
          }
          if (!apiKey) {
            reply(501, { error: '未配置 DEEPSEEK_API_KEY，请参考 .env.example 建 .env.local' });
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);

          let image: unknown;
          try {
            image = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { image?: unknown }).image;
          } catch {
            reply(400, { error: '请求体不是合法 JSON' });
            return;
          }
          if (typeof image !== 'string' || !image.startsWith('data:image/')) {
            reply(400, { error: '缺少 image（data URL）' });
            return;
          }

          const started = Date.now();
          const upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
            reply(502, { error: payload?.error?.message ?? `上游返回 ${upstream.status}` });
            return;
          }

          const content = payload.choices?.[0]?.message?.content ?? '';
          const jsonText = content
            .replace(/^```(?:json)?\s*/m, '')
            .replace(/```\s*$/m, '')
            .trim();

          let parsed: { level?: string; words?: unknown; uncertain?: unknown } = {};
          try {
            parsed = JSON.parse(jsonText) as typeof parsed;
          } catch {
            reply(502, { error: `模型输出不是 JSON：${jsonText.slice(0, 160)}` });
            return;
          }

          const words = Array.isArray(parsed.words)
            ? parsed.words
                .filter((word): word is { text: string; teach?: boolean } => {
                  return typeof (word as { text?: unknown })?.text === 'string';
                })
                .map((word) => ({ text: word.text, teach: word.teach !== false }))
            : [];

          reply(200, {
            model,
            level: typeof parsed.level === 'string' ? parsed.level : null,
            words,
            uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : [],
            usage: payload.usage ?? null,
            latencyMs: Date.now() - started,
          });
        })().catch((error: unknown) => {
          reply(500, { error: error instanceof Error ? error.message : '复核失败' });
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const rootDir = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, rootDir, '');

  return {
    plugins: [
      react(),
      pwaPlugin(fileURLToPath(new URL('./dist', import.meta.url))),
      vlmReviewPlugin({
        apiKey: env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '',
        model: env.VLM_MODEL ?? 'deepseek-flash',
        baseUrl: (env.VLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, ''),
      }),
    ],
    // 只有 VITE_ 前缀的变量会被注入前端，DEEPSEEK_API_KEY 不会
    envDir: rootDir,
    resolve: {
      alias: {
        '@kea/shared-types': fileURLToPath(
          new URL('../../packages/shared-types/src/index.ts', import.meta.url),
        ),
      },
    },
    server: {
      host: true,
      port: 5173,
      fs: { allow: [rootDir] },
    },
  };
});
