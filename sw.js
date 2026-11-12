// Offline cache: the app shell + model + MediaPipe files are cached after first load (cache-first, versioned).
const VERSION = 'mrp-web-v1';
const CORE = ['./', './index.html', './css/style.css', './manifest.webmanifest', './js/app.js', './js/rig.js', './js/tracker.js', './js/camera.js', './js/pose.js',
  './js/recorder.js', './js/mp_map.js', './js/mood.js', './js/demo_presets.js', './js/settings.js', './data/rig.json', './models/MrPuzzles_Head.glb', './models/label.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
