import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function fnv(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isHeavyStatic(file: string): boolean {
  return (
    file.startsWith('tesseract/') ||
    file.startsWith('lexicon/') ||
    file.startsWith('samples/') ||
    file.startsWith('icons/')
  );
}

export interface ServiceWorkerTemplateOptions {
  appCache: string;
  staticCache: string;
  shellUrls: string[];
  staticPrefixes: string[];
  indexUrl: string;
}

/**
 * 生成 Service Worker 源码。
 * 重要兼容约束（iPad Safari / WebKit）：
 * - `event.waitUntil(...)` 必须在 `fetch` 监听器的同步执行阶段注册，不能在 `event.respondWith(async () => ...)`
 *   里经过 `await` 后再异步调用，否则 WebKit 可能抛出 `InvalidStateError`，导致未缓存的 OCR 模型/Worker 请求全部失败；
 * - 所有 CacheStorage 读写都做容错，任何缓存异常都透明回退到网络 `fetch`，不阻断首屏与识别资源加载。
 */
export function generateServiceWorkerSource({
  appCache,
  staticCache,
  shellUrls,
  staticPrefixes,
  indexUrl,
}: ServiceWorkerTemplateOptions): string {
  return `const APP_CACHE=${JSON.stringify(appCache)};
const STATIC_CACHE=${JSON.stringify(staticCache)};
const SHELL_ASSETS=${JSON.stringify(shellUrls)};
const STATIC_PREFIXES=${JSON.stringify(staticPrefixes)};
const INDEX=${JSON.stringify(indexUrl)};
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(SHELL_ASSETS);
    await self.skipWaiting();
  })());
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') {
    void self.skipWaiting();
  }
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== APP_CACHE && key !== STATIC_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.endsWith('/sw.js')) return;
  const isPage = event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const isStatic = STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  let resolveBg;
  const bgTasks = [];
  event.waitUntil(new Promise((resolve) => {
    resolveBg = resolve;
  }));
  const finishBg = () => {
    void Promise.allSettled(bgTasks).finally(() => resolveBg());
  };
  event.respondWith((async () => {
    try {
      if (isPage) {
        let cache = null;
        try {
          cache = await caches.open(APP_CACHE);
        } catch {
          cache = null;
        }
        try {
          const fresh = await fetch(event.request, { cache: 'no-store' });
          if (cache && fresh.ok && fresh.status === 200 && !fresh.redirected) {
            try {
              const copy = fresh.clone();
              bgTasks.push(cache.put(INDEX, copy).catch(() => undefined));
            } catch {
              // 忽略克隆或写缓存异常
            }
          }
          return fresh;
        } catch (error) {
          if (cache) {
            const fallback =
              (await cache.match(event.request, { ignoreSearch: true }).catch(() => undefined)) ||
              (await cache.match(INDEX).catch(() => undefined));
            if (fallback) return fallback;
          }
          throw error;
        }
      }
      let cache = null;
      try {
        cache = await caches.open(isStatic ? STATIC_CACHE : APP_CACHE);
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
      } catch {
        cache = null;
      }
      const response = await fetch(event.request);
      if (cache && response.ok && response.status === 200 && !response.redirected) {
        try {
          const copy = response.clone();
          bgTasks.push(cache.put(event.request, copy).catch(() => undefined));
        } catch {
          // 忽略克隆或写缓存异常
        }
      }
      return response;
    } finally {
      finishBg();
    }
  })());
});
`;
}

/**
 * 构建结束后写出 sw.js。
 * - 轻量应用壳（HTML / JS / CSS）随版本缓存，秒级完成 install，不抢占首屏与识别带宽；
 * - 模型与词库放在持久缓存桶 kea-static-v4，改代码发版不会触发重新下载十几 MB 的模型。
 */
export function pwaPlugin(distDir: string): Plugin {
  let base = '/';
  return {
    name: 'kea-pwa',
    apply: 'build',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    closeBundle() {
      const files = walk(distDir)
        .map((full) => relative(distDir, full).split(sep).join('/'))
        .filter((file) => file !== 'sw.js' && file !== '.nojekyll')
        .sort();
      const shellFiles = files.filter((file) => !isHeavyStatic(file));
      const shellUrls = [...new Set([base, ...shellFiles.map((file) => `${base}${file}`)])];
      const staticPrefixes = ['tesseract/', 'lexicon/', 'samples/', 'icons/'].map(
        (prefix) => `${base}${prefix}`,
      );
      const indexUrl = `${base}index.html`;
      const appCache = `kea-app-${fnv(shellUrls.join('\n'))}`;
      const staticCache = 'kea-static-v4';
      const source = generateServiceWorkerSource({
        appCache,
        staticCache,
        shellUrls,
        staticPrefixes,
        indexUrl,
      });
      writeFileSync(join(distDir, 'sw.js'), source);
    },
  };
}
