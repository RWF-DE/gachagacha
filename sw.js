// Service Worker（DESIGN.md §8）
// - 全ファイルを install で precache、fetch は cache-first、navigate は index.html。
// - 本番中の強制リロードを避けるため skipWaiting は自動では呼ばない。
//   スタッフ画面から {type:'SKIP_WAITING'} を受けたときだけ有効化する。
// - ファイルを更新してデプロイするときは VERSION を上げること（上げないと古いキャッシュが使われ続ける）。
const VERSION = 2;
const CACHE_PREFIX = 'yosoro-gacha-';
const CACHE = `${CACHE_PREFIX}v${VERSION}`;

// sw.js からの相対パス。ファイルを追加したらここにも追加する。
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/tokens.css',
  'css/app.css',
  'css/stage.css',
  'js/config.js',
  'js/lottery.js',
  'js/db.js',
  'js/util.js',
  'js/ui.js',
  'js/app.js',
  'js/admin.js',
  'js/scene.js',
  'js/stage.js',
  'js/sound.js',
  'js/confetti.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // HTTPキャッシュを経由せず、常に最新を取りに行く
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 自分の接頭辞のキャッシュだけ削除（他サイトのキャッシュには触らない）
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ?fast=1 などのクエリは無視して照合する
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match('index.html');
      if (index) return index;
    }
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const index = await cache.match('index.html');
        if (index) return index;
      }
      return new Response('offline', { status: 503, statusText: 'offline' });
    }
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'CHECK_CACHE') {
    // スタッフ画面用：precache の全ファイルがキャッシュにあるか
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const missing = [];
      for (const u of PRECACHE) {
        if (!(await cache.match(u))) missing.push(u);
      }
      event.ports[0]?.postMessage({ ok: missing.length === 0, total: PRECACHE.length, missing, cache: CACHE });
    })());
  }
});
