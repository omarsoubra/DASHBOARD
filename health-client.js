/* ==========================================================================
   LOCKED IN Apple Health — in-app connect (Omar 2026-10-14)
   --------------------------------------------------------------------------
   Loaded by push-client.js (the shared script every client shell includes) and
   booted with the same client login it already has. Nothing is added to any
   client page; nothing here can break the page: every entry point is guarded.

   iPhone only (Apple Health lives there). A card on the Home screen:
     not connected  -> Connect: a sheet asks for agreement, then "Add to Shortcuts"
                       (the client's upload code is copied first; Apple's own
                       Add Shortcut screen asks for it), then "Run it once" and the
                       one-time nightly automation, then it detects the first sync.
     connected      -> today's steps / active energy / last night's sleep (or resting heart rate), when it
                       last synced, Sync now, Manage (stop sharing + delete).
   Rules: the client token only travels in POST bodies to the api; the upload
   code is shown nowhere, kept on this phone only until the first sync arrives;
   all dynamic text is set with textContent; prefers-reduced-motion is honoured.
   ========================================================================== */
(function () {
  'use strict';
  if (window.LockedInHealth) return;

  var SHORTCUT_URL = 'https://www.icloud.com/shortcuts/3e90791bd8de432cb4814e28188ad8a2';
  var SHORTCUT_NAME = 'LOCKED IN Health';
  var VERSION = 'health-v1-2026-10-14';
  var UA = navigator.userAgent || '';
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var FORCE = /[?&]lihealth=1\b/.test(location.search);           // preview on a desktop browser

  var o = null, status = null, sheet = null, poll = null;
  var LS = function (k) { return 'lih_' + k + '_' + (o ? o.storageKey : ''); };
  var get = function (k) { try { return localStorage.getItem(LS(k)); } catch (e) { return null; } };
  var put = function (k, v) { try { if (v == null) localStorage.removeItem(LS(k)); else localStorage.setItem(LS(k), v); } catch (e) {} };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { n.addEventListener(e, attrs.on[e]); }); else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svg(path, cls) {
    var w = document.createElement('span'); w.className = cls || 'lih-ic';
    w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';     // fixed markup only
    return w;
  }
  var HEART = '<path d="M12 20.3s-7.6-4.6-7.6-10.2A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.6 2.7c0 5.6-7.6 10.2-7.6 10.2z" fill="currentColor"/>';
  var CHECK = '<path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  var SYNC = '<path d="M20 11a8 8 0 0 0-14.5-4.6M4 13a8 8 0 0 0 14.5 4.6M5 3v4h4M19 21v-4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

  function api(type, extra) {
    var tok = ''; try { tok = o.getToken() || ''; } catch (e) {}
    if (!tok) return Promise.reject(new Error('no_token'));
    return fetch(o.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ type: type, storageKey: o.storageKey, token: tok }, extra || {})) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || j.ok !== true) throw new Error((j && j.error) || 'failed'); return j; });
  }
  function refresh() {
    return api('healthSelfStatus').then(function (s) {
      status = s;
      if (s.connected && s.days && s.days.length) put('k', null);          // the Shortcut has its code: forget it here
      render();
      var fresh = s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < 10 * 60e3;
      if (sheet && s.connected && s.days && s.days.length && (sheet.dataset.step === 'finish' || sheet.dataset.step === 'add' || (sheet.dataset.step === 'fix' && fresh))) step('done');
      return s;
    }).catch(function () { render(); });
  }

  // ── styles (scoped to .lih-*; inherit the page font) ─────────────────────
  function css() {
    if (document.getElementById('lih-css')) return;
    var s = document.createElement('style'); s.id = 'lih-css';
    s.textContent = [
      '.lih-card{position:relative;overflow:hidden;border-radius:20px;padding:18px;margin:0 0 14px;color:#f4f5f8;background:#0c0e13;',
      ' box-shadow:0 18px 40px -22px rgba(12,14,19,.55),inset 0 0 0 1px rgba(255,255,255,.06);isolation:isolate}',
      '.lih-aurora{position:absolute;inset:-40%;z-index:-1;opacity:.9;filter:blur(38px);',
      ' background:radial-gradient(40% 35% at 20% 25%,rgba(255,45,85,.55),transparent 70%),radial-gradient(35% 30% at 85% 20%,rgba(232,84,46,.45),transparent 70%),',
      ' radial-gradient(45% 40% at 70% 95%,rgba(124,92,255,.40),transparent 70%);animation:lih-drift 14s ease-in-out infinite alternate}',
      '@keyframes lih-drift{0%{transform:translate3d(-4%,-3%,0) rotate(0)}100%{transform:translate3d(5%,4%,0) rotate(8deg)}}',
      '.lih-row{display:flex;align-items:center;gap:14px}',
      '.lih-orb{position:relative;width:46px;height:46px;flex:0 0 46px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08);color:#ff375f}',
      '.lih-orb::before{content:"";position:absolute;inset:-3px;border-radius:50%;padding:2px;background:conic-gradient(from 0deg,#ff375f,#e8542e,#7c5cff,#ff375f);',
      ' -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:lih-spin 6s linear infinite}',
      '.lih-orb::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 0 rgba(255,55,95,.45);animation:lih-pulse 2.6s ease-out infinite}',
      '@keyframes lih-spin{to{transform:rotate(360deg)}}@keyframes lih-pulse{0%{box-shadow:0 0 0 0 rgba(255,55,95,.42)}100%{box-shadow:0 0 0 16px rgba(255,55,95,0)}}',
      '.lih-ic svg,.lih-orb svg{width:22px;height:22px;display:block}',
      '.lih-tx b{display:block;font-size:16px;letter-spacing:-.01em}.lih-tx span{display:block;font-size:13px;line-height:1.35;color:rgba(244,245,248,.72);margin-top:2px}',
      '.lih-chips{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0}.lih-chips span{font-size:11.5px;padding:5px 9px;border-radius:99px;background:rgba(255,255,255,.08);color:rgba(244,245,248,.85);',
      ' backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
      '.lih-cta{position:relative;overflow:hidden;width:100%;margin-top:16px;border:0;border-radius:14px;padding:14px 16px;font:inherit;font-size:15.5px;font-weight:700;',
      ' color:#0c0e13;background:linear-gradient(180deg,#fff,#e9eaef);cursor:pointer;box-shadow:0 8px 22px -12px rgba(255,255,255,.5)}',
      '.lih-cta::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),transparent);',
      ' transform:skewX(-20deg);animation:lih-shine 3.4s ease-in-out infinite}@keyframes lih-shine{0%,60%{left:-60%}100%{left:130%}}',
      '.lih-cta[disabled]{opacity:.55}.lih-ghost{background:rgba(255,255,255,.1);color:#f4f5f8;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}.lih-ghost::after{display:none}',
      '.lih-metrics{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:8px;margin-top:16px}',
      '.lih-m{border-radius:14px;padding:11px 12px;background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}',
      '.lih-m b{display:block;font-size:22px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.lih-m:first-child b{font-size:26px}',
      '.lih-m span{display:block;font-size:11px;color:rgba(244,245,248,.66);margin-top:1px}',
      '.lih-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:rgba(244,245,248,.66)}',
      '.lih-acts{display:inline-flex;gap:6px}.lih-link{border:0;background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);color:#f4f5f8;font:inherit;font-size:12.5px;font-weight:600;',
      ' display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border-radius:99px;cursor:pointer;line-height:1;white-space:nowrap}',
      '.lih-link .lih-ic svg{width:15px;height:15px}',
      '.lih-live{display:inline-flex;align-items:center;gap:6px}.lih-live i{width:7px;height:7px;border-radius:50%;background:#30d158;box-shadow:0 0 0 0 rgba(48,209,88,.6);animation:lih-dot 2s infinite}',
      '@keyframes lih-dot{0%{box-shadow:0 0 0 0 rgba(48,209,88,.55)}100%{box-shadow:0 0 0 8px rgba(48,209,88,0)}}',
      // sheet
      '.lih-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(8,9,12,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .25s}',
      '.lih-scrim.on{opacity:1}',
      '.lih-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;max-width:560px;margin:0 auto;border-radius:24px 24px 0 0;padding:10px 20px calc(22px + env(safe-area-inset-bottom,0px));',
      ' color:#f4f5f8;background:rgba(14,16,21,.92);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);',
      ' box-shadow:0 -20px 60px -20px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.08);transform:translateY(100%);transition:transform .38s cubic-bezier(.2,.8,.2,1);overflow:hidden}',
      '.lih-sheet.on{transform:none}.lih-grab{width:38px;height:5px;border-radius:5px;background:rgba(255,255,255,.22);margin:2px auto 14px}',
      '.lih-sheet h3,.lih-card b{color:#fff!important;font-family:inherit}.lih-sheet h3{margin:12px 0 6px;font-size:22px;letter-spacing:-.02em;text-align:center}.lih-sheet h3+p{text-align:center}.lih-sheet p{margin:0 0 10px;font-size:14px;line-height:1.5;color:rgba(244,245,248,.75)}',
      '.lih-dots{display:flex;gap:6px;justify-content:center;margin:0 0 4px}.lih-dots i{width:22px;height:4px;border-radius:4px;background:rgba(255,255,255,.16);transition:background .3s}',
      '.lih-dots i.on{background:linear-gradient(90deg,#ff375f,#e8542e)}',
      '.lih-hero{display:grid;place-items:center;margin:8px 0 4px}.lih-hero .lih-orb{width:72px;height:72px;flex-basis:72px}.lih-hero .lih-orb svg{width:32px;height:32px}',
      '.lih-check{display:flex;gap:10px;align-items:flex-start;margin:14px 0 2px;font-size:13.5px;color:rgba(244,245,248,.85);line-height:1.4}',
      '.lih-check input{width:20px;height:20px;margin-top:1px;accent-color:#ff375f;flex:0 0 auto}',
      '.lih-steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px}',
      '.lih-steps li{display:flex;gap:12px;align-items:center;padding:12px;border-radius:14px;background:rgba(255,255,255,.06);font-size:13.5px;line-height:1.35}',
      '.lih-steps li b{color:#fff}.lih-steps small{display:block;margin-top:3px;font-size:12px;color:rgba(244,245,248,.6);line-height:1.45}.lih-ok-orb::before{background:conic-gradient(from 0deg,#30d158,#0fd1a0,#30d158)!important}.lih-n{width:26px;height:26px;flex:0 0 26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;background:rgba(255,255,255,.12)}',
      '.lih-steps li.ok .lih-n{background:#30d158;color:#06210f}',
      '.lih-fine{font-size:11.5px!important;color:rgba(244,245,248,.5)!important;margin-top:10px!important}',
      '.lih-close{position:absolute;top:12px;right:14px;width:32px;height:32px;border-radius:50%;border:0;background:rgba(255,255,255,.1);color:#fff;font-size:18px;line-height:32px;cursor:pointer}',
      '.lih-stale .lih-orb{color:#ffb340}.lih-stale .lih-orb::before{background:conic-gradient(from 0deg,#ffb340,#ff7a1a,#ffb340)}',
      '.lih-pop{animation:lih-pop .5s cubic-bezier(.2,1.4,.4,1)}@keyframes lih-pop{0%{transform:scale(.6);opacity:0}100%{transform:none;opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.lih-aurora,.lih-orb::before,.lih-orb::after,.lih-cta::after,.lih-live i{animation:none}.lih-sheet{transition:none}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── Home card ─────────────────────────────────────────────────────────────
  function fmtInt(n) { return n == null ? '—' : Math.round(n).toLocaleString('en-AU'); }
  function fmtSleep(m) { m = Math.round(m); return Math.floor(m / 60) + 'h ' + (m % 60 < 10 ? '0' : '') + (m % 60); }
  function when(iso) {
    try {
      var d = new Date(iso), now = new Date();
      var t = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(' ', '');
      if (d.toDateString() === now.toDateString()) return 'today ' + t;
      var y = new Date(now); y.setDate(now.getDate() - 1);
      return (d.toDateString() === y.toDateString() ? 'yesterday ' : d.toLocaleDateString('en-AU', { weekday: 'short' }) + ' ') + t;
    } catch (e) { return ''; }
  }
  function card() {
    var c = el('div', { class: 'lih-card', id: 'lih-card' }, [el('div', { class: 'lih-aurora' })]);
    var connected = status && status.connected, days = (status && status.days) || [];
    var lastSync = status && status.lastSyncAt ? Date.parse(status.lastSyncAt) : NaN;
    var stale = connected && days.length && isFinite(lastSync) && Date.now() - lastSync > 36 * 3600e3;
    if (stale) {                                   // the nightly sync stopped (automation off, or a permission declined)
      c.classList.add('lih-stale');
      c.appendChild(el('div', { class: 'lih-row' }, [el('div', { class: 'lih-orb' }, [svg(HEART)]),
        el('div', { class: 'lih-tx' }, [el('b', { text: 'Apple Health sync paused' }),
          el('span', { text: 'Last synced ' + when(status.lastSyncAt) + '. One tap to get it going again.' })])]));
      c.appendChild(el('button', { type: 'button', class: 'lih-cta', on: { click: function () { open('fix'); } } }, ['Fix it']));
      return c;
    }
    if (connected && days.length) {
      var d = days[0];
      c.appendChild(el('div', { class: 'lih-row' }, [el('div', { class: 'lih-orb' }, [svg(HEART)]),
        el('div', { class: 'lih-tx' }, [el('b', { text: 'Apple Health' }), el('span', { text: d.day === today() ? 'Today so far' : 'Last synced day' })])]));
      c.appendChild(el('div', { class: 'lih-metrics' }, [
        el('div', { class: 'lih-m' }, [el('b', { text: fmtInt(d.steps) }), el('span', { text: 'steps' })]),
        el('div', { class: 'lih-m' }, [el('b', { text: fmtInt(d.active_kcal) }), el('span', { text: 'active kcal' })]),
        d.sleep_min != null
          ? el('div', { class: 'lih-m' }, [el('b', { text: fmtSleep(d.sleep_min) }), el('span', { text: 'sleep' })])
          : el('div', { class: 'lih-m' }, [el('b', { text: d.resting_hr != null ? String(d.resting_hr) : '—' }), el('span', { text: 'resting bpm' })])]));
      c.appendChild(el('div', { class: 'lih-foot' }, [
        el('span', { class: 'lih-live' }, [el('i'), el('span', { text: 'Synced ' + when(d.received_at) })]),
        el('span', { class: 'lih-acts' }, [el('button', { type: 'button', class: 'lih-link', on: { click: syncNow } }, [svg(SYNC), 'Sync now']),
                        el('button', { type: 'button', class: 'lih-link', on: { click: function () { open('manage'); } } }, ['Manage'])])]));
      return c;
    }
    var pending = connected || get('k');
    c.appendChild(el('div', { class: 'lih-row' }, [el('div', { class: 'lih-orb' }, [svg(HEART)]),
      el('div', { class: 'lih-tx' }, [el('b', { text: pending ? 'Finish connecting Apple Health' : 'Connect Apple Health' }),
        el('span', { text: pending ? 'One last step — then it syncs every night on its own.' : 'Your steps, calories and recovery, synced to your coaching automatically.' })])]));
    if (!pending) c.appendChild(el('div', { class: 'lih-chips' }, [el('span', { text: 'Steps' }), el('span', { text: 'Active energy' }), el('span', { text: 'Sleep' }), el('span', { text: 'Private to Omar' })]));
    c.appendChild(el('button', { type: 'button', class: 'lih-cta', on: { click: function () { open(pending ? (get('k') ? 'add' : 'finish') : 'consent'); } } }, [pending ? 'Finish setup' : 'Connect']));
    return c;
  }
  function today() { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); } catch (e) { return ''; } }

  function host() {
    var home = document.getElementById('cv2-cv2home-page');
    if (home) { var lab = home.querySelector('.cv2-seclabel'); return lab ? { parent: home, before: lab } : { parent: home }; }
    var push = document.getElementById('li-push-settings');                 // classic layout fallback
    return push ? { parent: push.parentNode, before: push } : null;
  }
  function render() {
    try {
      var h = host(); if (!h) return;
      var old = document.getElementById('lih-card');
      var c = card();
      if (old && old.parentNode === h.parent) { old.replaceWith(c); return; }
      if (old) old.remove();
      if (h.before) h.parent.insertBefore(c, h.before);
      else h.parent.appendChild(c);
    } catch (e) {}
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function runShortcut() { try { window.location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT_NAME); } catch (e) {} }
  function syncNow() { put('synctap', String(Date.now())); runShortcut(); }
  function copy(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text); } catch (e) {}
    return Promise.reject(new Error('no_clipboard'));
  }

  // ── sheet ─────────────────────────────────────────────────────────────────
  var STEPS = ['consent', 'add', 'finish', 'done'];
  function open(which) {
    close(true);
    var scrim = el('div', { class: 'lih-scrim', on: { click: function () { close(); } } });
    sheet = el('div', { class: 'lih-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Apple Health' });
    document.body.appendChild(scrim); document.body.appendChild(sheet);
    requestAnimationFrame(function () { scrim.classList.add('on'); sheet.classList.add('on'); });
    step(which);
    clearInterval(poll); poll = setInterval(function () { if (!document.hidden && sheet && (sheet.dataset.step === 'finish' || sheet.dataset.step === 'fix')) refresh(); }, 5000);
  }
  function close(instant) {
    clearInterval(poll); poll = null;
    var sc = document.querySelector('.lih-scrim'), sh = document.querySelector('.lih-sheet');
    if (!sh) return;
    if (instant) { sc && sc.remove(); sh.remove(); sheet = null; return; }
    sc && sc.classList.remove('on'); sh.classList.remove('on');
    setTimeout(function () { sc && sc.remove(); sh.remove(); }, 380); sheet = null;
  }
  function frame(stepName, kids) {
    sheet.dataset.step = stepName; sheet.innerHTML = '';
    sheet.appendChild(el('div', { class: 'lih-grab' }));
    sheet.appendChild(el('button', { type: 'button', class: 'lih-close', 'aria-label': 'Close', on: { click: function () { close(); } } }, ['×']));
    var idx = STEPS.indexOf(stepName);
    if (idx >= 0) sheet.appendChild(el('div', { class: 'lih-dots' }, STEPS.map(function (s, i) { return el('i', { class: i <= idx ? 'on' : '' }); })));
    kids.forEach(function (k) { sheet.appendChild(k); });
  }
  function hero() { return el('div', { class: 'lih-hero' }, [el('div', { class: 'lih-orb' }, [svg(HEART)])]); }
  function step(s) {
    if (!sheet) return;
    if (s === 'consent') {
      var cb = el('input', { type: 'checkbox' });
      var btn = el('button', { type: 'button', class: 'lih-cta', disabled: 'disabled' }, ['Agree & continue']);
      cb.addEventListener('change', function () { if (cb.checked) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', 'disabled'); });
      btn.addEventListener('click', function () {
        btn.setAttribute('disabled', 'disabled'); btn.textContent = 'Connecting…';
        api('healthSelfConnect', { agree: true, version: (status && status.consentVersion) || VERSION }).then(function (r) {
          put('k', r.healthKey); status = Object.assign({}, status || {}, { connected: true }); render(); step('add');
        }).catch(function () { btn.removeAttribute('disabled'); btn.textContent = 'Couldn’t connect — tap to retry'; });
      });
      frame('consent', [hero(), el('h3', { text: 'Connect Apple Health' }),
        el('p', { text: 'Once a day your iPhone shares your daily steps, active calories, exercise minutes, resting heart rate and sleep with Omar — so your calories and training match how active and recovered you really are.' }),
        el('div', { class: 'lih-chips' }, [el('span', { text: 'Only Omar sees it' }), el('span', { text: 'Never sold or shared' }), el('span', { text: 'Stop anytime — data deleted' })]),
        el('label', { class: 'lih-check' }, [cb, el('span', { text: 'I agree to share these daily totals for my coaching, and I’m 18+ (or my parent/guardian agrees).' })]),
        btn]);
    } else if (s === 'add') {
      var code = get('k');
      var add = el('button', { type: 'button', class: 'lih-cta' }, ['Add to Shortcuts']);
      add.addEventListener('click', function () {
        // copy inside the tap (iOS requires it), then hand over to Apple's Add Shortcut screen
        copy(code || '').then(function () {}, function () {});
        put('added', '1');
        window.open(SHORTCUT_URL, '_blank', 'noopener');
        setTimeout(function () { if (sheet) step('finish'); }, 900);
      });
      frame('add', [hero(), el('h3', { text: 'Add the LOCKED IN Shortcut' }),
        el('p', { text: 'Your private code is copied. Apple’s Add Shortcut screen opens next:' }),
        el('ol', { class: 'lih-steps' }, [
          el('li', {}, [el('span', { class: 'lih-n', text: '1' }), el('span', {}, ['Tap ', el('b', { text: 'Set Up Shortcut' })])]),
          el('li', {}, [el('span', { class: 'lih-n', text: '2' }), el('span', {}, ['Tap the box, ', el('b', { text: 'Paste' }), ', then ', el('b', { text: 'Add Shortcut' })])]),
          el('li', {}, [el('span', { class: 'lih-n', text: '3' }), el('span', {}, ['Come back here'])])]),
        add]);
    } else if (s === 'finish') {
      var ran = !!get('ran');
      var run = el('button', { type: 'button', class: 'lih-cta' + (ran ? ' lih-ghost' : '') }, [ran ? 'Run it again' : 'Run first sync']);
      run.addEventListener('click', function () { put('ran', '1'); runShortcut(); });
      var auto = el('button', { type: 'button', class: 'lih-cta' + (ran ? '' : ' lih-ghost') }, ['Open Shortcuts']);
      auto.addEventListener('click', function () { try { window.location.href = 'shortcuts://'; } catch (e) {} });
      frame('finish', [el('h3', { text: 'Two taps from done' }),
        el('ol', { class: 'lih-steps' }, [
          el('li', { class: ran ? 'ok' : '' }, [el('span', { class: 'lih-n', text: ran ? '✓' : '1' }), el('span', {}, [el('b', { text: 'Run the first sync' }),
            el('small', { text: 'Tap Always Allow for each question, then come back here. If it says “does not have access”: Settings → Health → Data Access & Devices → Shortcuts → Turn On All, then run it again.' })])]),
          el('li', {}, [el('span', { class: 'lih-n', text: '2' }), el('span', {}, [el('b', { text: 'Make it automatic' }), ' — one time, about 20 seconds',
            el('small', { text: 'Shortcuts → Automation → + → Time of Day → 9:00 PM · Daily · Run Immediately → Next → ' + SHORTCUT_NAME })])])]),
        run, auto,
        el('p', { class: 'lih-fine', text: 'This screen turns green by itself as soon as your first sync arrives.' })]);
    } else if (s === 'fix') {
      var again = el('button', { type: 'button', class: 'lih-cta' }, ['Sync now']);
      again.addEventListener('click', function () { put('ran', '1'); runShortcut(); });
      var openSc = el('button', { type: 'button', class: 'lih-cta lih-ghost' }, ['Open Shortcuts']);
      openSc.addEventListener('click', function () { try { window.location.href = 'shortcuts://'; } catch (e) {} });
      frame('fix', [el('h3', { text: 'Get syncing again' }),
        el('ol', { class: 'lih-steps' }, [
          el('li', {}, [el('span', { class: 'lih-n', text: '1' }), el('span', {}, [el('b', { text: 'Sync now' }),
            el('small', { text: 'If your iPhone asks, tap Always Allow. If it says “does not have access”: Settings → Health → Data Access & Devices → Shortcuts → Turn On All, then run it again.' })])]),
          el('li', {}, [el('span', { class: 'lih-n', text: '2' }), el('span', {}, [el('b', { text: 'Check the nightly automation' }),
            el('small', { text: 'Shortcuts → Automation: "Time of Day 9:00 PM" should run ' + SHORTCUT_NAME + ' with Run Immediately. If it’s missing, add it: + → Time of Day → 9:00 PM · Daily · Run Immediately.' })])])]),
        again, openSc,
        el('p', { class: 'lih-fine', text: 'This turns green by itself as soon as a sync arrives.' })]);
    } else if (s === 'done') {
      var d = (status && status.days && status.days[0]) || {};
      frame('done', [el('div', { class: 'lih-hero lih-pop' }, [el('div', { class: 'lih-orb lih-ok-orb', style: 'color:#30d158' }, [svg(CHECK)])]),
        el('h3', { text: 'You’re synced' }),
        el('p', { text: (d.steps != null ? fmtInt(d.steps) + ' steps today. ' : '') + 'From now on it updates every night at 9pm — nothing else to do.' }),
        el('button', { type: 'button', class: 'lih-cta', on: { click: function () { close(); } } }, ['Done'])]);
    } else if (s === 'manage') {
      var stop = el('button', { type: 'button', class: 'lih-cta lih-ghost' }, ['Stop sharing & delete my data']);
      stop.addEventListener('click', function () {
        if (!confirm('Stop sharing Apple Health and delete everything Omar has received?')) return;
        stop.setAttribute('disabled', 'disabled');
        api('healthSelfDisconnect').then(function () {
          put('k', null); put('ran', null); put('added', null); status = { connected: false, days: [] }; render();
          frame('manage', [el('h3', { text: 'Sharing stopped' }), el('p', { text: 'Your Apple Health data has been deleted. You can also delete the LOCKED IN Health shortcut and its automation in the Shortcuts app.' }),
            el('button', { type: 'button', class: 'lih-cta', on: { click: function () { close(); } } }, ['Done'])]);
        }).catch(function () { stop.removeAttribute('disabled'); stop.textContent = 'Couldn’t stop — tap to retry'; });
      });
      frame('manage', [el('h3', { text: 'Apple Health' }),
        el('p', { text: 'Your daily steps, active calories, exercise minutes, resting heart rate and sleep sync every night at 9pm. Only Omar sees them.' }),
        el('button', { type: 'button', class: 'lih-cta', on: { click: function () { step('consent'); } } }, ['Set it up on this phone']), stop]);
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  function boot(opts) {
    try {
      if (o || !(IS_IOS || FORCE)) return;
      if (!opts || !opts.storageKey || typeof opts.getToken !== 'function' || !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api$/.test(opts.apiUrl || '')) return;
      o = opts; css();
      var home = document.getElementById('cv2-cv2home-page');
      if (home && window.MutationObserver) new MutationObserver(function () { if (!document.getElementById('lih-card')) render(); }).observe(home, { childList: true });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
      refresh();
    } catch (e) {}
  }
  window.LockedInHealth = { boot: boot };
})();
