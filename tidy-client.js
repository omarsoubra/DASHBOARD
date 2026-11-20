/* LOCKED IN — client app tidy-ups (2026-11-20), loaded by push-client.js on V2 client pages.
   Small fixes over the page's own V2 screens. It never changes what is saved or sent.
     1. Nutrition: ingredients show as a list, not one "+"-joined paragraph.
     2. Progress: cards with nothing in them yet are hidden (consistency, strength, body measurements, empty history).
     3. Home: today's workout comes first; the plan-update card and the setup card sit under it.
     4. Weigh-in: the empty Body weight card points to the one place weight is logged (Home).
     5. Notifications: opened from the profile menu in a sheet, no longer parked at the bottom of Progress.
     6. The floating green INSTALL APP button is hidden; "Install the app" is a row in the profile menu.
     7. Dead-end lines removed ("another phone", "in-app messaging isn't available yet").
   Everything is re-applied after the page re-draws a screen, and every step is safe to run twice. */
(function () {
  'use strict';
  if (window.LockedInTidy) return;
  var on = false, queued = false, pushHome = null;

  function css() {
    if (document.getElementById('lit-css')) return;
    var s = document.createElement('style'); s.id = 'lit-css';
    s.textContent = [
      'body.cv2 .lit-hide.lit-hide.lit-hide,body.cv2 #section-tracker .lit-hide.lit-hide{display:none!important}',
      'body.cv2 .cv2-ing ul.lit-ing{list-style:none;margin:4px 0 0;padding:0}',
      'body.cv2 .cv2-ing ul.lit-ing li{position:relative;padding:7px 0 7px 16px;font-size:14px;line-height:1.4;color:var(--c-text,#16181c);border-bottom:1px solid var(--c-line,#e7e2d9);overflow-wrap:anywhere}',
      'body.cv2 .cv2-ing ul.lit-ing li:last-child{border-bottom:0}',
      'body.cv2 .cv2-ing ul.lit-ing li::before{content:"";position:absolute;left:2px;top:14px;width:6px;height:6px;border-radius:50%;background:var(--c-accent,#e8542e)}',
      '.lit-bd{position:fixed;inset:0;z-index:9000;background:rgba(22,24,28,.45);display:flex;align-items:flex-end;justify-content:center}',
      '.lit-sh{width:100%;max-width:560px;max-height:86vh;overflow:auto;background:var(--c-bg,#f5f3ef);border-radius:22px 22px 0 0;padding:10px 16px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 40px rgba(0,0,0,.18)}',
      '.lit-grip{width:38px;height:4px;border-radius:2px;background:var(--c-line,#d9d4ca);margin:0 auto 12px}',
      '.lit-top{display:flex;align-items:center;justify-content:space-between;margin:0 2px 10px}.lit-top b{font-size:19px;font-weight:800;letter-spacing:-.02em;color:var(--c-text,#16181c)}',
      '.lit-x{font:inherit;font-size:14px;font-weight:800;border:0;background:var(--c-surface,#fff);color:var(--c-text,#16181c);border-radius:12px;padding:9px 14px;cursor:pointer}',
      '.lit-sh #li-push-settings{margin-top:0!important}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }
  function hide(n) { if (n && !n.classList.contains('lit-hide')) n.classList.add('lit-hide'); }
  function show(n) { if (n && n.classList.contains('lit-hide')) n.classList.remove('lit-hide'); }

  // 1 ── ingredients as a list ──────────────────────────────────────────────────────────────────────────────────────
  function ingredients() {
    var all = document.querySelectorAll('details.cv2-ing');
    for (var i = 0; i < all.length; i++) {
      var d = all[i], p = null;
      for (var k = 0; k < d.children.length; k++) if (d.children[k].tagName === 'P') { p = d.children[k]; break; }
      if (!p || p.getAttribute('data-lit')) continue;
      p.setAttribute('data-lit', '1');
      var parts = (p.textContent || '').split(/\s+\+\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (parts.length < 2) continue;
      var ul = document.createElement('ul'); ul.className = 'lit-ing';
      parts.forEach(function (x) { var li = document.createElement('li'); li.textContent = x; ul.appendChild(li); });
      p.parentNode.insertBefore(ul, p.nextSibling); hide(p);
    }
  }

  // 2 + 4 ── Progress: nothing-yet cards, and where weight is logged ─────────────────────────────────────────────────
  function progress() {
    var top = document.getElementById('cv2-progress-top');
    if (top) {
      var cards = top.querySelectorAll('.cv2-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i], e = c.querySelector('.cv2-empty'); if (!e) continue;
        var title = (c.textContent || '');
        if (/^\s*Body weight/.test(title)) {   // keep it: tells a new client where their weight goes
          var sp = e.querySelector('span'), want = 'No weigh-ins yet. Log your morning weight on Home and your trend shows here.';
          if (sp && /weekly check-in below/.test(sp.textContent) ) sp.textContent = want;
          continue;
        }
        if (c.children.length <= 2) hide(c);
      }
    }
    var hist = document.querySelector('#section-tracker .checkin-history');
    if (hist) { if (/No check-ins yet/.test(hist.textContent || '') && !hist.querySelector('.checkin-item,.cv2-ck')) hide(hist); else show(hist); }
    var box = document.getElementById('li-push-settings');
    if (box && !box.closest('.lit-sh')) hide(box);
  }

  // 3 ── Home: workout first ─────────────────────────────────────────────────────────────────────────────────────────
  function home() {
    var h = document.getElementById('cv2-cv2home-page'); if (!h) return;
    var hero = h.querySelector('.cv2-hero'); if (!hero || hero.parentNode !== h) return;
    var wc = document.getElementById('cv2-wc') || document.getElementById('cv2-wc-slot');
    var setup = document.getElementById('lis-setup'), after = hero;
    if (wc && wc.parentNode === h) { if (hero.nextElementSibling !== wc) h.insertBefore(wc, hero.nextSibling); after = wc; }
    if (setup && setup.parentNode === h && after.nextElementSibling !== setup) h.insertBefore(setup, after.nextSibling);
  }

  // 5 + 6 ── profile menu: Notifications in a sheet, Install the app ─────────────────────────────────────────────────
  function installEvent() { try { return (typeof _deferredInstall !== 'undefined' && _deferredInstall && _deferredInstall.prompt) ? _deferredInstall : null; } catch (e) { return null; } }
  function closeNotifications() {
    var bd = document.querySelector('.lit-bd'); if (!bd) return;
    var box = document.getElementById('li-push-settings');
    try { if (box && pushHome && pushHome.parent) pushHome.parent.insertBefore(box, pushHome.next && pushHome.next.parentNode === pushHome.parent ? pushHome.next : null); } catch (e) {}
    bd.remove(); run();
  }
  function notifications() {
    try { if (typeof window.cv2CloseSheet === 'function') window.cv2CloseSheet(); } catch (e) {}
    var box = document.getElementById('li-push-settings'); if (!box || document.querySelector('.lit-bd')) return;
    pushHome = { parent: box.parentNode, next: box.nextSibling };
    var bd = document.createElement('div'); bd.className = 'lit-bd'; bd.setAttribute('role', 'dialog'); bd.setAttribute('aria-modal', 'true'); bd.setAttribute('aria-label', 'Notifications');
    var sh = document.createElement('div'); sh.className = 'lit-sh';
    var grip = document.createElement('div'); grip.className = 'lit-grip';
    var top = document.createElement('div'); top.className = 'lit-top';
    var b = document.createElement('b'); b.textContent = 'Notifications';
    var x = document.createElement('button'); x.type = 'button'; x.className = 'lit-x'; x.textContent = 'Done'; x.addEventListener('click', closeNotifications);
    top.appendChild(b); top.appendChild(x); sh.appendChild(grip); sh.appendChild(top); sh.appendChild(box); bd.appendChild(sh);
    bd.addEventListener('click', function (e) { if (e.target === bd) closeNotifications(); });
    document.body.appendChild(bd); show(box);
    try { var head = box.querySelector('.lip-head[aria-expanded="false"]'); if (head) head.click(); } catch (e) {}
  }
  function install() {
    try { if (typeof window.cv2CloseSheet === 'function') window.cv2CloseSheet(); } catch (e) {}
    var ev = installEvent(); if (!ev) return;
    try { ev.prompt(); if (ev.userChoice && ev.userChoice.then) ev.userChoice.then(function () { try { _deferredInstall = null; } catch (e) {} run(); }, function () {}); } catch (e) {}
  }
  function menu() {
    var rows = document.querySelectorAll('#cv2-sheet .cv2-row');
    if (!rows.length) return;
    var bell = null, hasInstall = false;
    for (var i = 0; i < rows.length; i++) {
      var oc = rows[i].getAttribute('onclick') || '';
      if (oc.indexOf('li-push-settings') >= 0) bell = rows[i];
      if (oc.indexOf('checkin-history') >= 0) { var hh = document.querySelector('#section-tracker .checkin-history'); if (hh && /No check-ins yet/.test(hh.textContent || '')) hide(rows[i]); }   // nothing to show yet
      if (rows[i].getAttribute('data-lit') === 'install') hasInstall = true;
    }
    if (bell) bell.setAttribute('onclick', 'LockedInTidy.notifications()');
    var last = rows[rows.length - 1];
    if (!hasInstall && installEvent() && last && /cv2More|classic|cv2Then|cv2Go/.test(last.getAttribute('onclick') || '') && document.querySelector('#cv2-sheet #cv2-sheet-h')) {
      var r = last.cloneNode(true); r.setAttribute('data-lit', 'install'); r.setAttribute('onclick', 'LockedInTidy.install()');
      var t = r.querySelector('.tx b'), sm = r.querySelector('.tx small');
      if (t) t.textContent = 'Install the app'; if (sm) sm.textContent = 'Opens from your Home Screen';
      last.parentNode.insertBefore(r, last);
    }
  }
  function floaters() {
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i]; if (k.id || k.className) continue;
      if (k.tagName === 'BUTTON' && /INSTALL APP/.test(k.textContent || '')) hide(k);
    }
  }

  // 7 ── dead-end lines ──────────────────────────────────────────────────────────────────────────────────────────────
  function copy() {
    var ps = document.querySelectorAll('p.cv2-p, p.hint');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], tx = p.textContent || '';
      if (/tick on another phone/.test(tx)) { hide(p); continue; }
      if (/messaging isn.t available yet/.test(tx) && !p.children.length) {
        p.textContent = tx.replace(/\s*[—-]\s*in-app messaging isn.t available yet\./i, '.').replace(/\s*In-app messaging isn.t available yet\./, '');
      }
    }
  }

  function run() {
    queued = false;
    [ingredients, progress, home, menu, floaters, copy].forEach(function (f) { try { f(); } catch (e) {} });
  }
  function queue() { if (queued) return; queued = true; setTimeout(run, 40); }

  function boot() {
    try {
      if (on) return;
      if (!document.body.classList.contains('cv2')) return;   // V2 screens only
      on = true; css(); run();
      if (window.MutationObserver) new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNotifications(); });
    } catch (e) {}
  }

  window.LockedInTidy = { boot: boot, notifications: notifications, install: install, _run: run };
})();
