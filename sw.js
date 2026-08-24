// Service Worker（設計書.md 8.6 完全オフライン対応）
//
// 重要：デプロイのたびに CACHE_VERSION を上げること。
// activate で古いキャッシュを削除しないと、素材を差し替えても反映されない。
//
// キャッシュは2段構え。
//   CRITICAL … install でブロッキング取得。これが揃えば起動できる（約1.5MB）
//   DEFERRED … BGM。activate 後にバックグラウンドで取得する（約6.5MB）
// BGMまで install で待つと初回の「準備中」が体感に出るため分けている。
// 取得前にBGMが要求された場合は fetch ハンドラがネットワークから取ってキャッシュする。

const CACHE_VERSION = 'kare-v6';

// アプリシェル＋データ＋画像
const CRITICAL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/audio.js',
  './js/engine.js',
  './scenes.json',
  './recordings.json',
  './public/assets/bg/bg_cafe.webp',
  './public/assets/bg/bg_station.webp',
  './public/assets/bg/bg_town_day.webp',
  './public/assets/bg/bg_town_evening.webp',
  './public/assets/chara/friend/normal.webp',
  './public/assets/chara/friend/suspicious.webp',
  './public/assets/chara/friend/smile.webp',
  './public/assets/chara/friend/cold.webp',
  './public/assets/chara/girlfriend/away.webp',
  './public/assets/chara/girlfriend/bored.webp',
  './public/assets/chara/girlfriend/fluster.webp',
  './public/assets/chara/girlfriend/laugh.webp',
  './public/assets/chara/girlfriend/normal.webp',
  './public/assets/chara/girlfriend/smile.webp',
  './public/assets/chara/girlfriend/smug.webp',
  // 効果音（合計77KB）。押した瞬間に鳴る必要があるので後回しにしない
  './public/assets/se/se_select.wav',
  './public/assets/se/se_confirm.wav',
  './public/assets/se/se_rec_start.wav',
  './public/assets/se/se_rec_stop.wav',
];

// BGM（甘茶の音楽工房）。サイズが大きいので後追いで取得する
const DEFERRED = [
  './public/assets/bgm/bgm_daily.m4a',
  './public/assets/bgm/bgm_evening.m4a',
  './public/assets/bgm/bgm_honne.m4a',
  './public/assets/bgm/bgm_ending.m4a',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(CRITICAL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();

    // BGMは待たずに裏で取得する。失敗しても起動は妨げない
    const cache = await caches.open(CACHE_VERSION);
    for (const url of DEFERRED) {
      try {
        if (!(await cache.match(url))) await cache.add(url);
      } catch (_) { /* オフライン初回などは次回に回す */ }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // 外部ホストは使わない方針（CDN・Webフォントを入れない）
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 後追い分がまだ無い場合はここで拾ってキャッシュする
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, res.clone());
      }
      return res;
    } catch (_) {
      return (await caches.match('./index.html')) || Response.error();
    }
  })());
});
