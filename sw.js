/* Doc Tracker service worker.
   1) makes the app work fully offline,
   2) lets a reminder notification open the app when tapped,
   3) best-effort background check of document reminders (Chrome "periodic background sync").
   If you change any app file, bump CACHE so phones pick up the new version.
   The prefix keeps this app's cache separate from other apps on the same github.io address. */
const PREFIX = 'doc-tracker-';
const CACHE = PREFIX + 'v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(event.request, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        return fetch(event.request)
          .then((res) => {
            if (res && res.ok && new URL(event.request.url).origin === self.location.origin) {
              cache.put(event.request, res.clone());
            }
            return res;
          })
          .catch(() => cache.match('./index.html'));
      })
    )
  );
});

/* ---------- reminders (the page keeps a copy of the schedule in IndexedDB) ---------- */
function idbOpen() {
  return new Promise(function (resolve, reject) {
    var r = indexedDB.open('docTracker', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); };
  });
}
function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error); };
    });
  });
}
function idbSet(key, value) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoToday() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function daysBetweenISO(a, b) {
  var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
// which reminders have been reached (and not yet shown)? Same rules as the page.
function computeDue(m, today) {
  var out = [];
  ((m && m.items) || []).forEach(function (it) {
    (it.dates || []).forEach(function (d) { if (d <= today && today <= it.expiry) out.push({ key: it.id + '|' + d, it: it, kind: 'remind' }); });
    if (it.expiry < today && daysBetweenISO(it.expiry, today) <= 30) out.push({ key: it.id + '|exp', it: it, kind: 'expired' });
  });
  return out;
}
var SW_TEXT = {
  pl: { title: 'Dokumenty wymagają uwagi', remind: 'ważny do ', expired: 'po terminie od ', loc: 'pl-PL' },
  en: { title: 'Documents need attention', remind: 'expires ', expired: 'expired ', loc: 'en-GB' }
};
function buildNotification(list, lang) {
  var x = SW_TEXT[lang] || SW_TEXT.en;
  var lines = list.map(function (d) {
    var p = d.it.expiry.split('-').map(Number);
    var date = new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(x.loc, { day: 'numeric', month: 'short', year: 'numeric' });
    return d.it.title + (d.it.owner ? ' (' + d.it.owner + ')' : '') + ': ' + (d.kind === 'expired' ? x.expired : x.remind) + date;
  });
  return { title: x.title, body: lines.join('\n') };
}
function checkReminders() {
  return idbGet('mirror').then(function (m) {
    if (!m) return;
    var shown = m.shown || {};
    var fresh = computeDue(m, isoToday()).filter(function (d) { return !shown[d.key]; });
    if (!fresh.length) return;
    var n = buildNotification(fresh, m.lang);
    return self.registration.showNotification(n.title, {
      body: n.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'doc-reminders', renotify: true
    }).then(function () {
      fresh.forEach(function (d) { shown[d.key] = true; });
      m.shown = shown;
      return idbSet('mirror', m);
    });
  }).catch(function () { /* notifications not allowed, or no data yet: nothing to do */ });
}
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'doc-reminders') event.waitUntil(checkReminders());
});

// Tapping a reminder notification brings the app to the front (or opens it).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
