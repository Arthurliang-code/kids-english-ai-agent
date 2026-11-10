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

/**
 * 构建结束后写出 sw.js。
 * - 轻量应用壳（HTML / JS / CSS）随版本缓存，秒级完成 install，不抢占首屏与识别带宽；
 * - 模型与词库放在持久缓存桶 kea-static-v2，改代码发版不会触发重新下载十几 MB 的模型。
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
      const staticCache = 'kea-static-v3';
      const source = `const APP_CACHE=${JSON.stringify(appCache)};
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
  event.respondWith((async () => {
    if (isPage) {
      const cache = await caches.open(APP_CACHE);
      try {
        const fresh = await fetch(event.request, { cache: 'no-store' });
        cache.put(INDEX, fresh.clone());
        return fresh;
      } catch (error) {
        return (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match(INDEX)) || Promise.reject(error);
      }
    }
    const cache = await caches.open(isStatic ? STATIC_CACHE : APP_CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) cache.put(event.request, response.clone());
    return response;
  })());
});
`;
      writeFileSync(join(distDir, 'sw.js'), source);
    },
  };
}
