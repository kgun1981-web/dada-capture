// 앱 화면 파일만 캐시합니다. 사진·메모는 IndexedDB에만 있고 네트워크로 보내지 않습니다.
// 배포할 때마다 VERSION을 올립니다. 같은 주소의 다른 앱 캐시는 건드리지 않도록 이 앱 접두어 캐시만 정리·조회합니다.
const PREFIX = 'dada-capture-shell-';
const VERSION = PREFIX + 'v11';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  // cache:'reload' — 브라우저 HTTP 캐시에 남은 이전 버전 파일을 새 캐시에 넣지 않도록 항상 서버에서 새로 받음
  // 새 버전 파일을 하나라도 못 받으면 반쯤 만든 캐시를 지우고 설치를 실패시킴 → 이전 버전이 그대로 동작
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting())
    .catch((e) => caches.delete(VERSION).then(() => { throw e; })));
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
