// Decrypts the locked game files on this phone. Nothing readable is stored on the server.
const VER = '20261031095048';
const CACHE = 'enc';   // kept across updates; each file is keyed by its own version
let vers = null, versAt = 0;
async function getVers(force) {
  if (vers && !force && Date.now() - versAt < 60000) return vers;
  try {
    const r = await fetch(new URL('d/v.json', self.registration.scope).pathname + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) { vers = await r.json(); versAt = Date.now(); }
  } catch (_) {}
  return vers || {};
}
async function pruneCache() {
  const v = await getVers(true); if (!v || !Object.keys(v).length) return;
  const keep = new Set(Object.entries(v).map(([n, h]) => 'd/' + n + '.bin?h=' + h));
  const c = await caches.open(CACHE);
  for (const req of await c.keys()) { const u = new URL(req.url); const k = u.pathname.split('/').slice(-2).join('/') + u.search; if (!keep.has(k)) await c.delete(req); }
}
const BASE = new URL('./', self.registration.scope).pathname;
const APP = BASE + 'app/';
const TYPES = { html: 'text/html; charset=utf-8', mp3: 'audio/mpeg', png: 'image/png', json: 'application/json', webmanifest: 'application/manifest+json', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
let keys = null;

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ssk', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function getKeys() {
  if (keys) return keys;
  try {
    const db = await openDb();
    keys = await new Promise((res) => {
      const q = db.transaction('k').objectStore('k').get('keys');
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch (_) { keys = null; }
  return keys;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
  pruneCache();
})()));
self.addEventListener('message', (e) => { if (e.data === 'reset') keys = null; });

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(APP)) return;
  e.respondWith(serve(e.request, u.pathname.slice(APP.length)));
});

async function serve(req, path) {
  path = decodeURIComponent(path || 'index.html');
  if (path.endsWith('/')) path += 'index.html';
  const k = await getKeys();
  if (!k) return req.mode === 'navigate' ? Response.redirect(BASE, 302) : new Response('', { status: 401 });
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k.mac, new TextEncoder().encode(path)));
  const name = Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  const v = await getVers(req.mode === 'navigate');
  const url = BASE + 'd/' + name + '.bin?h=' + (v[name] || 'x' + Date.now());
  const cache = await caches.open(CACHE);
  let r = await cache.match(url);
  if (!r && !v[name]) r = await cache.match(BASE + 'd/' + name + '.bin', { ignoreSearch: true });   // offline: use what we have
  if (!r) {
    try { r = await fetch(url); } catch (_) { return new Response('', { status: 503 }); }
    if (!r.ok) return new Response('', { status: 404 });
    try { await cache.put(url, r.clone()); } catch (_) {}
  }
  const buf = await r.arrayBuffer();
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, k.aes, new Uint8Array(buf, 12));
  } catch (_) { return new Response('', { status: 500 }); }
  const type = TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
  const total = plain.byteLength;
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let s, en;
    if (!m[1]) { s = Math.max(0, total - Number(m[2])); en = total - 1; }
    else { s = Number(m[1]); en = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1; }
    if (s >= total) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
    return new Response(plain.slice(s, en + 1), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${s}-${en}/${total}`, 'Content-Length': String(en - s + 1), 'Accept-Ranges': 'bytes' } });
  }
  return new Response(plain, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
}
