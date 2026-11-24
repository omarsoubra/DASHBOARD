// Coach Platform V1 (Omar 2026-11-24). A client of another coach reaches this login page as /login/?c=<coach>.
// This file re-skins the page for that coach: their name, colour and logo, and their first name wherever the page
// would say "Omar". With no ?c= (every LOCKED IN client) it does nothing at all.
// The coach is remembered on this device so a later visit without the link still shows their brand; /login/?c= clears it.
(function () {
  'use strict';
  var KEY = 'li_login_coach', slug = null;
  try {
    var q = /[?&]c=([a-z0-9]{0,16})(?:&|$)/.exec(location.search);
    if (q) { slug = q[1] || null; if (slug) localStorage.setItem(KEY, slug); else localStorage.removeItem(KEY); }
    else slug = localStorage.getItem(KEY);
  } catch (e) {}
  var root = document.documentElement;
  function reveal() { root.classList.remove('cb-wait'); }
  if (!slug || !/^[a-z0-9]{2,16}$/.test(slug)) { reveal(); return; }
  var CFG = window.LI_AUTH_CONFIG || {};
  if (!CFG.apiUrl) { reveal(); return; }

  function lum(hex) { var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function apply(b) {
    var brand = String(b.brand || 'Coaching'), first = String(b.coachFirstName || 'your coach');
    function fix(t) {
      return t.replace(/Message Omar and he[’']ll send you a secure link/g, 'Message ' + first + ' for a secure link')
              .replace(/\bOmar\b/g, first).replace(/LOCKED IN/g, brand);
    }
    function walk(node) {
      if (node.nodeType === 3) { var v = fix(node.nodeValue); if (v !== node.nodeValue) node.nodeValue = v; return; }
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|INPUT|TEXTAREA)$/.test(node.tagName)) return;
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    }
    var wm = document.querySelector('.wordmark'); if (wm) wm.textContent = brand;
    var logo = document.querySelector('img.logo');
    if (logo) { logo.src = b.logo ? 'data:image/png;base64,' + b.logo : '../brand/coach-default-v1-192.png'; logo.alt = brand; logo.style.borderRadius = '18px'; }
    document.title = fix(document.title);
    var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (meta) meta.setAttribute('content', brand);
    walk(document.body);
    // messages are written into the page later (errors, link states): keep them in the coach's words too
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === 'characterData') { var v = fix(m.target.nodeValue); if (v !== m.target.nodeValue) m.target.nodeValue = v; }
        else Array.prototype.forEach.call(m.addedNodes, walk);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    if (/^#[0-9a-f]{6}$/i.test(b.accent || '')) {
      var a = b.accent, light = lum(a) > 0.3;
      var st = document.createElement('style');
      st.textContent = ':root{--accent:' + a + ';--accent-2:' + a + ';}' +
        'body{background:radial-gradient(120% 70% at 50% -10%,' + a + '38,transparent 60%),var(--bg)!important;}' +
        '.splash .spin{border-color:' + a + '40!important;border-top-color:' + a + '!important;}' +
        (light ? '.btn:not(.ghost){color:#16161a!important;}' : '') +
        (lum(a) < 0.08 ? ':root{--accent:#e5e7eb;--accent-2:#e5e7eb;}.btn:not(.ghost){color:#16161a!important;}' : '');
      document.head.appendChild(st);
    }
    reveal();
  }
  var done = false;
  setTimeout(function () { if (!done) reveal(); }, 4000);          // never leave the page blank if the lookup is slow
  fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, cache: 'no-store', body: JSON.stringify({ type: 'cpBrand', slug: slug }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { done = true; if (j && j.ok) apply(j); else { try { localStorage.removeItem(KEY); } catch (e) {} reveal(); } })
    .catch(function () { done = true; reveal(); });
})();
