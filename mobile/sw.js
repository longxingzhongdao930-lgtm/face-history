// オフライン対応: 顔認識モデル・ライブラリは端末に保存して再利用し、画面・コードは最新を優先する。
const VERSION = '__BUILD_VERSION__';
const CACHE = `face-history-${VERSION}`;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'manifest.webmanifest',
  'shared/liveness.js', 'shared/matcher.js', 'shared/backup-format.js'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('face-history-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // モデル（約 12MB）とライブラリはキャッシュ優先
  if (/\/(models|vendor)\//.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((cache) => cache.put(request, res.clone()));
        return res;
      })),
    );
    return;
  }
  // それ以外はネットワーク優先（更新をすぐ反映）、オフライン時はキャッシュ
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((cache) => cache.put(request, res.clone()));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('index.html'))),
  );
});
