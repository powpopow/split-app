// #166 — detect a newer deploy without a service worker. Vite content-hashes the entry bundle
// (assets/index-<hash>.js) and rewrites index.html to point at it, so a changed hash === a new
// build. We fetch index.html fresh (no-store, cache-busted) and compare its entry hash to the one
// THIS page actually loaded. Front-end only; no backend, no manual version file to keep in sync.
const RX = /assets\/index-[A-Za-z0-9_-]+\.js/;

export async function isUpdateAvailable() {
  try {
    // the entry bundle this page is currently running
    const cur = [...document.querySelectorAll('script[type="module"][src]')]
      .map((s) => s.getAttribute('src') || '')
      .map((src) => (src.match(RX) || [])[0])
      .find(Boolean);
    if (!cur) return false; // dev server (main.jsx, not a hashed bundle) -> skip
    const base = import.meta.env.BASE_URL || '/';
    const resp = await fetch(`${base}index.html?_=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return false;
    const html = await resp.text();
    const latest = (html.match(RX) || [])[0];
    return !!latest && latest !== cur;
  } catch { return false; }
}
