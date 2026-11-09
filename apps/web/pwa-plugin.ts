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

/** 构建结束后写出 sw.js。页面走网络优先，模型等静态资源仍可离线。 */
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
      const urls = [...new Set([base, ...files.map((file) => `${base}${file}`)])];
      const indexUrl = `${base}index.html`;
      const cache = `kea-${fnv(urls.join('\n'))}`;
      const source = `const CACHE=${JSON.stringify(cache)};
const ASSETS=${JSON.stringify(urls)};
const INDEX=${JSON.stringify(indexUrl)};
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.endsWith('/sw.js')) return;
  const isPage = event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isPage) {
      try {
        const fresh = await fetch(event.request, { cache: 'no-store' });
        cache.put(INDEX, fresh.clone());
        return fresh;
      } catch (error) {
        return (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match(INDEX)) || Promise.reject(error);
      }
    }
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(event.request);
    cache.put(event.request, response.clone());
    return response;
  })());
});
`;
      writeFileSync(join(distDir, 'sw.js'), source);
    },
  };
}
