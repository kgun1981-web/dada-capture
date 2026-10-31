// 앱 화면 파일만 캐시합니다. 사진·메모는 IndexedDB에만 있고 네트워크로 보내지 않습니다.
// 배포할 때마다 VERSION을 올립니다. 같은 주소의 다른 앱 캐시는 건드리지 않도록 이 앱 접두어 캐시만 정리·조회합니다.
const PREFIX = 'dada-capture-shell-';
const VERSION = PREFIX + 'v2';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return fetch(req);
    })
  );
});
