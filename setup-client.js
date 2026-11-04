/* ==========================================================================
   LOCKED IN — "Set up your app" card on Home (Omar 2026-11-04)
   --------------------------------------------------------------------------
   Only 10 of 43 clients were getting reminders. On iPhone, reminders only work
   from the Home Screen app, and the Home Screen copy forgets the WhatsApp link,
   so a client who installs before saving a login gets locked out. This card
   walks every client through the four steps in the order that works:

     1. Save your login         (account-setup.js sheet)
     2. Add to your Home Screen (iPhone/Android steps; iPhone waits for step 1)
     3. Turn on reminders       (push-client.js, the same tap as the Progress switch)
     4. Log your first weigh-in (plus-client.js weigh-in card)

   Loaded by push-client.js next to this file, V2 pages only, never in coach
   view. It only reads state and calls those files' own actions: no new server
   calls, no secrets, every entry point try/catch guarded. When all four are
   done it says so once, then never shows again on that phone. "Later" hides it
   for a day.
   ========================================================================== */
(function () {
  'use strict';
  if (window.LockedInSetup) return;

  var UA = navigator.userAgent || '';
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /Android/i.test(UA);
  var SNOOZE_MS = 24 * 3600 * 1000;
  var o = null, acct = null, celebrated = false;

  function standalone() {
    try { return window.navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { return false; }
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') for (var ev in attrs.on) n.addEventListener(ev, attrs.on[ev]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var LSK = function () { return 'li_setup_' + o.storageKey; };
  function st() { try { return JSON.parse(localStorage.getItem(LSK()) || 'null') || {}; } catch (e) { return {}; } }
  function put(s) { try { localStorage.setItem(LSK(), JSON.stringify(s)); } catch (e) {} }

  function css() {
    if (document.getElementById('lis-css')) return;
    var s = el('style', { id: 'lis-css' });
    s.textContent = [
      '.lis-card{background:var(--c-surface,#fff);border:1px solid var(--c-line,#e7e2d9);border-radius:20px;padding:18px 16px 12px;margin:0 0 14px;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.lis-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}',
      '.lis-top b{font-size:17px;font-weight:800;letter-spacing:-.01em}.lis-top span{font-size:12.5px;color:var(--c-muted,#5d636b);font-weight:700;white-space:nowrap}',
      '.lis-sub{margin:4px 0 10px;font-size:13px;color:var(--c-muted,#5d636b);line-height:1.4}',
      '.lis-bar{height:6px;border-radius:99px;background:var(--c-surface2,#f5f3ef);overflow:hidden;margin-bottom:6px}.lis-bar i{display:block;height:100%;background:var(--c-accent,#e8542e);border-radius:99px;transition:width .3s}',
      '.lis-step{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--c-line,#e7e2d9)}.lis-step:first-of-type{border-top:0}',
      '.lis-n{flex:0 0 28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;background:var(--c-surface2,#f5f3ef);color:var(--c-muted,#5d636b)}',
      '.lis-step.done .lis-n{background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48)}',
      '.lis-tx{flex:1 1 auto;min-width:0}.lis-tx b{display:block;font-size:14.5px;font-weight:700}.lis-tx small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin-top:1px;line-height:1.35}',
      '.lis-step.done .lis-tx b{color:var(--c-muted,#5d636b);text-decoration:line-through;text-decoration-thickness:1px}',
      '.lis-go{flex:0 0 auto;font:inherit;font-weight:800;font-size:13.5px;padding:9px 13px;border-radius:12px;border:0;background:var(--c-accent,#e8542e);color:#fff;cursor:pointer;white-space:nowrap}',
      '.lis-go[disabled]{background:var(--c-surface2,#f5f3ef);color:var(--c-dim,#8a8d93);cursor:default}',
      '.lis-later{display:block;margin:6px auto 0;font:inherit;font-size:12.5px;font-weight:700;background:none;border:0;color:var(--c-muted,#5d636b);text-decoration:underline;cursor:pointer;padding:6px}',
      '.lis-bd{position:fixed;inset:0;z-index:2147482990;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;padding:0 10px calc(10px + env(safe-area-inset-bottom))}',
      '.lis-sh{width:100%;max-width:440px;background:var(--c-surface,#fff);color:var(--c-text,#16181c);border-radius:20px;padding:20px 18px 14px}',
      '.lis-sh h3{margin:0 0 10px;font-size:19px;font-weight:800;letter-spacing:-.02em}.lis-sh ol{margin:0 0 12px;padding-left:20px;font-size:14.5px;line-height:1.5}.lis-sh li{margin:0 0 8px}',
      '.lis-sh p{margin:0 0 12px;font-size:13px;color:var(--c-muted,#5d636b);line-height:1.4}',
      '.lis-sh .lis-go{display:block;width:100%;padding:13px}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── step state (each read is guarded: a missing helper file just means "not done yet") ─────────────────────────────
  function push() { try { return window.LockedInPush && window.LockedInPush.current; } catch (e) { return null; } }
  function steps() {
    var s = st(), mobile = IS_IOS || IS_ANDROID, home = standalone();
    var p = push(), d = null; try { d = p && p.diagnostics(); } catch (e) {}
    var login = acct === 'active' || s.login === true;
    var out = [];
    out.push({ id: 'login', done: login, title: 'Save your login',
      hint: acct === 'needs_invite' ? 'Message Omar and he\'ll send your login link.' : 'An email + password, so you never get locked out.',
      btn: acct === 'needs_invite' ? null : 'Set up', can: acct === 'can_setup' || acct == null, act: openLogin });
    if (mobile) out.push({ id: 'home', done: home, title: 'Add LOCKED IN to your Home Screen',
      hint: IS_IOS && !login ? 'Do step 1 first, so the Home Screen app can sign you in.' : 'Opens like an app, and reminders can reach you.',
      btn: 'Show me', can: !(IS_IOS && !login), act: openHome });
    var pushOk = d && d.pushSupported && !(IS_IOS && !home);
    var remindersOn = !!(d && d.permission === 'granted' && d.registeredOnServer);
    if (d && (d.pushSupported || IS_IOS)) out.push({ id: 'push', done: remindersOn, title: 'Turn on reminders',
      hint: d.permission === 'denied' ? 'Blocked on this phone: Settings → Notifications → LOCKED IN → Allow.'
        : IS_IOS && !home ? 'Works once you open LOCKED IN from your Home Screen.' : 'Training at 5pm and your meals, so nothing slips.',
      btn: 'Turn on', can: pushOk && d.permission !== 'denied', act: enablePush });
    var n = 0; try { n = window.LockedInPlus && window.LockedInPlus.weighCount ? window.LockedInPlus.weighCount() : 0; } catch (e) {}
    out.push({ id: 'weigh', done: n > 0 || s.weigh === true, title: 'Log your first weigh-in',
      hint: 'Morning, after the toilet, before food. Takes 10 seconds.', btn: 'Log it', can: true, act: openWeigh });
    if (n > 0 && !s.weigh) put(Object.assign(st(), { weigh: true }));
    return out;
  }

  // ── actions ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function openLogin() {
    try {
      if (window.LockedInAccount && window.LockedInAccount.open()) {
        var tries = 0;   // re-check once the sheet closes
        (function wait() { if (document.getElementById('lia-ask') && tries++ < 600) return setTimeout(wait, 500); refreshAccount(); })();
      }
    } catch (e) {}
  }
  function sheet(title, items, note, btn) {
    var bd = el('div', { class: 'lis-bd', role: 'dialog', 'aria-modal': 'true' });
    var close = function () { bd.remove(); render(); };
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    var ol = el('ol', {}, items.map(function (t) { return el('li', { text: t }); }));
    bd.appendChild(el('div', { class: 'lis-sh' }, [el('h3', { text: title }), ol, note ? el('p', { text: note }) : null,
      btn || el('button', { type: 'button', class: 'lis-go', text: 'Got it', on: { click: close } })]));
    document.body.appendChild(bd);
  }
  function openHome() {
    try {
      var ev = (typeof _deferredInstall !== 'undefined') ? _deferredInstall : null;   // the page's own beforeinstallprompt
      if (IS_ANDROID && ev && ev.prompt) { ev.prompt(); return; }
    } catch (e) {}
    if (IS_IOS) {
      sheet('Add to your Home Screen', [
        'Open this page in Safari. From WhatsApp: tap ••• or the compass icon, then "Open in Safari".',
        'Tap the Share button (the square with the arrow) at the bottom.',
        'Scroll down, tap "Add to Home Screen", then "Add".',
        'Open LOCKED IN from your Home Screen and tap "Log in with email" - use the login from step 1.',
      ], 'Then come back to this card there and turn on reminders.');
    } else {
      sheet('Add to your Home Screen', [
        'Tap the ⋮ menu at the top right of Chrome.',
        'Tap "Install app" (or "Add to Home screen"), then "Install".',
        'Open LOCKED IN from your Home Screen.',
      ]);
    }
  }
  function enablePush() {
    var p = push(); if (!p || typeof p._onEnable !== 'function') return;
    try { var r = p._onEnable(); if (r && r.then) r.then(render, render); } catch (e) {}   // the tap itself asks iOS
  }
  function openWeigh() {
    try {
      var c = document.getElementById('lip-weigh');
      if (!c) return;
      c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var i = c.querySelector('.lip-in'); if (i) setTimeout(function () { try { i.focus(); } catch (e) {} }, 350);
    } catch (e) {}
  }

  // ── card ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    try {
      var home = document.getElementById('cv2-cv2home-page'); if (!home) return;
      var old = document.getElementById('lis-setup'), s = st();
      if (s.complete || (s.snoozedAt && Date.now() - s.snoozedAt < SNOOZE_MS)) { if (old) old.remove(); return; }
      var list = steps(), done = list.filter(function (x) { return x.done; }).length;
      if (done === list.length) {
        put(Object.assign(s, { complete: true }));
        if (old && !celebrated) {
          celebrated = true;
          old.replaceWith(el('div', { class: 'lis-card', id: 'lis-setup' }, [el('div', { class: 'lis-top' }, [el('b', { text: 'You\'re all set up ✅' })]),
            el('p', { class: 'lis-sub', text: 'Reminders are on and your weigh-ins reach Omar. Keep logging - that\'s how he adjusts your plan.' })]));
          setTimeout(function () { var n = document.getElementById('lis-setup'); if (n) n.remove(); }, 8000);
        } else if (old) old.remove();
        return;
      }
      var card = el('div', { class: 'lis-card', id: 'lis-setup' }, [
        el('div', { class: 'lis-top' }, [el('b', { text: 'Set up your app' }), el('span', { text: done + ' of ' + list.length + ' done' })]),
        el('p', { class: 'lis-sub', text: 'Two minutes, once. It\'s what lets Omar see your week and keep you on track.' }),
        el('div', { class: 'lis-bar' }, [el('i', { style: 'width:' + Math.round(done / list.length * 100) + '%' })]),
      ].concat(list.map(function (x, i) {
        return el('div', { class: 'lis-step' + (x.done ? ' done' : ''), 'data-step': x.id }, [
          el('span', { class: 'lis-n', text: x.done ? '✓' : String(i + 1) }),
          el('span', { class: 'lis-tx' }, [el('b', { text: x.title }), x.done ? null : el('small', { text: x.hint })]),
          x.done || !x.btn ? null : el('button', x.can ? { type: 'button', class: 'lis-go', text: x.btn, on: { click: x.act } }
                                                       : { type: 'button', class: 'lis-go', text: x.btn, disabled: 'disabled' }),
        ]);
      })).concat([el('button', { type: 'button', class: 'lis-later', text: 'Later', on: { click: function () { put(Object.assign(st(), { snoozedAt: Date.now() })); render(); } } })]));
      if (old) { old.replaceWith(card); return; }
      var hello = home.querySelector('.cv2-hello');
      if (hello && hello.parentNode) hello.parentNode.insertBefore(card, hello.nextSibling); else home.insertBefore(card, home.firstChild);
    } catch (e) {}
  }

  function refreshAccount() {
    try {
      if (!window.LockedInAccount) return render();
      window.LockedInAccount.status().then(function (a) {
        if (a) { acct = a; if (a === 'active') put(Object.assign(st(), { login: true })); }
        render();
      }, render);
    } catch (e) { render(); }
  }

  function boot(opts) {
    try {
      if (o || !opts || !opts.storageKey || window.__COACH_VIEW || /[?&]coach=1(&|$)/.test(location.search)) return;
      if (!document.body.classList.contains('cv2')) return;   // V2 screens only
      o = opts; css();
      var home = document.getElementById('cv2-cv2home-page');
      if (home && window.MutationObserver) new MutationObserver(function () { if (!document.getElementById('lis-setup')) render(); }).observe(home, { childList: true });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshAccount(); });
      var n = 0, t = setInterval(function () { render(); if (++n >= 15) clearInterval(t); }, 2000);   // push + weigh-ins load async
      refreshAccount();
    } catch (e) {}
  }

  window.LockedInSetup = { boot: boot, _t: { steps: function () { return steps(); }, render: render } };
})();
