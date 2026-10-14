/* ==========================================================================
   LOCKED IN · Your week + From Omar (Omar 2026-10-14)
   --------------------------------------------------------------------------
   Loaded by push-client.js (the shared script every client page includes) with
   the client's existing login. One read (clientWeekGet) per open:
     Home   "Last week" recap Mon-Wed: sessions, PRs, average weight, meals
            logged, steps vs their own goal, each against the week before; plus
            "Omar reviewed your week" when a new reply has landed.
     Coach  "Latest feedback" shows the replies Omar actually sent (newest first).
   Research: self-monitoring works when paired with feedback and review
   (Michie 2009); progress you can see keeps people going (goal-gradient).
   Rules: textContent only; nothing written; every entry point guarded.
   ========================================================================== */
(function () {
  'use strict';
  if (window.LockedInWeek) return;
  var o = null, data = null, lastLoad = 0;
  var LS = function (k) { return 'liw_' + k + '_' + (o ? o.storageKey : ''); };
  var get = function (k) { try { return localStorage.getItem(LS(k)); } catch (e) { return null; } };
  var put = function (k, v) { try { localStorage.setItem(LS(k), v); } catch (e) {} };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { n.addEventListener(e, attrs.on[e]); }); else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function css() {
    if (document.getElementById('liw-css')) return;
    var s = document.createElement('style'); s.id = 'liw-css';
    s.textContent = [
      '.liw-card{background:var(--c-surface,#fff);border:1px solid var(--c-line,#e7e2d9);border-radius:var(--c-r,18px);box-shadow:var(--c-shadow,0 8px 24px -14px rgba(22,24,28,.18));padding:16px 16px 14px;margin:14px 0 0;color:var(--c-text,#16181c);font-family:inherit}',
      '.liw-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:12px}',
      '.liw-head b{font-size:16px;font-weight:800;letter-spacing:-.01em}.liw-head span{font-size:12.5px;color:var(--c-muted,#5d636b);font-weight:600}',
      '.liw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.liw-t{background:var(--c-surface2,#f5f3ef);border-radius:12px;padding:10px 12px;min-width:0}',
      '.liw-t b{display:block;font-size:20px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.liw-t span{display:block;font-size:12px;color:var(--c-muted,#5d636b);margin-top:1px}',
      '.liw-t i{font-style:normal;font-size:11.5px;font-weight:700;margin-left:6px;color:var(--c-dim,#8a8d93)}.liw-t i.up{color:var(--c-ok,#0f7a48)}',
      '.liw-pr{margin-top:10px;padding:9px 12px;border-radius:12px;background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48);font-size:13.5px;font-weight:600}',
      '.liw-from{margin-top:10px;display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;border:1px solid var(--c-edge,#fbd5c5);background:#fff7f3;cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit}',
      '.liw-from .av{flex:0 0 auto;width:28px;height:28px;border-radius:50%;background:var(--c-accent,#e8542e);color:#fff;font-weight:800;font-size:12px;display:grid;place-items:center}',
      '.liw-from small{display:block;font-size:11.5px;color:var(--c-muted,#5d636b);font-weight:700;margin-bottom:1px}',
      '.liw-from p{margin:0;font-size:13.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.liw-fb{margin:0;white-space:pre-wrap;font-size:14.5px;line-height:1.5}',
      '.liw-fb-meta{font-size:12px;color:var(--c-muted,#5d636b);margin:8px 0 0}',
      '.liw-older{margin-top:12px;border-top:1px solid var(--c-line,#e7e2d9);padding-top:10px}',
      '.liw-older summary{cursor:pointer;font-size:13px;font-weight:700;color:var(--c-muted,#5d636b)}',
      '.liw-older .liw-fb{font-size:13.5px;margin-top:8px;color:var(--c-muted,#5d636b)}',
    ].join('');
    document.head.appendChild(s);
  }
  var first = function () { return String((window.CLIENT_CONFIG && CLIENT_CONFIG.coach && CLIENT_CONFIG.coach.name) || 'Omar').split(' ')[0]; };
  function fmtRange(a, b) {
    try {
      var A = new Date(a + 'T12:00:00'), Bd = new Date(b + 'T12:00:00');
      var m = function (d) { return d.toLocaleDateString('en-AU', { month: 'short' }); };
      return A.getDate() + (m(A) !== m(Bd) ? ' ' + m(A) : '') + '–' + Bd.getDate() + ' ' + m(Bd);
    } catch (e) { return ''; }
  }
  function when(iso) { try { var d = new Date(iso); return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return ''; } }
  var fmt = function (n) { return Math.round(n).toLocaleString('en-AU'); };
  function delta(now, prev, unit, digits) {
    if (now == null || prev == null) return null;
    var d = Math.round((now - prev) * Math.pow(10, digits || 0)) / Math.pow(10, digits || 0);
    if (!d) return el('i', { text: 'same' });
    var a = Math.abs(d); return el('i', { class: d > 0 ? 'up' : '', text: (d > 0 ? '▲ ' : '▼ ') + (a >= 1000 ? a.toLocaleString('en-AU') : a) + (unit || '') });
  }
  function tile(val, label, dl) { return el('div', { class: 'liw-t' }, [el('b', {}, [val, dl]), el('span', { text: label })]); }

  // ── Home: last week's recap (Mon-Wed) + "Omar reviewed your week" ─────────────────────────────────────────────────
  function homeCard() {
    if (!data) return null;
    var d = data, dow = new Date().getDay();              // 0 Sun .. 6 Sat
    var fb = (d.feedback || [])[0], fresh = fb && Date.now() - Date.parse(fb.sentAt) < 5 * 864e5;
    var recapDay = dow >= 1 && dow <= 3;
    var hasAny = d.sessions || d.weightAvg != null || d.mealDays || d.steps != null;
    if (!(recapDay && hasAny) && !fresh) return null;
    var c = el('div', { class: 'liw-card', id: 'liw-home' });
    if (recapDay && hasAny) {
      c.appendChild(el('div', { class: 'liw-head' }, [el('b', { text: 'Your week' }), el('span', { text: fmtRange(d.week.from, d.week.to) })]));
      var tiles = [tile(String(d.sessions), d.sessions === 1 ? 'session' : 'sessions', delta(d.sessions, d.sessionsPrev, '', 0))];
      if (d.weightAvg != null) tiles.push(tile(String(d.weightAvg), 'kg average', delta(d.weightAvg, d.weightAvgPrev, ' kg', 1)));
      tiles.push(tile(d.mealDays + '/7', 'days with meals logged', delta(d.mealDays, d.mealDaysPrev, '', 0)));
      if (d.steps != null) tiles.push(tile(fmt(d.steps), d.stepTarget ? 'steps/day · goal ' + fmt(d.stepTarget) : 'steps a day', delta(d.steps, d.stepsPrev, '', 0)));
      else if (d.sleepMin != null) tiles.push(tile(Math.floor(d.sleepMin / 60) + 'h ' + ('0' + d.sleepMin % 60).slice(-2), 'sleep a night', null));
      c.appendChild(el('div', { class: 'liw-grid' }, tiles.slice(0, 4)));
      if ((d.prs || []).length) {
        c.appendChild(el('div', { class: 'liw-pr', text: '🏆 New best' + (d.prs.length > 1 ? 's' : '') + ': ' +
          d.prs.slice(0, 3).map(function (p) { return p.exercise + ' ' + p.kg + ' kg (+' + (Math.round((p.kg - p.prev) * 10) / 10) + ')'; }).join(' · ') }));
      }
    }
    if (fresh) {
      var seen = get('seen') === fb.sentAt;
      c.appendChild(el('button', { type: 'button', class: 'liw-from', on: { click: function () { put('seen', fb.sentAt); goCoach(); } } }, [
        el('span', { class: 'av', text: first().charAt(0) }),
        el('span', {}, [el('small', { text: (seen ? first() + '’s feedback · ' : first() + ' reviewed your week · ') + when(fb.sentAt) }), el('p', { text: fb.text })])]));
      if (!(recapDay && hasAny)) c.insertBefore(el('div', { class: 'liw-head' }, [el('b', { text: 'From ' + first() }), el('span', { text: when(fb.sentAt) })]), c.firstChild);
    }
    return c;
  }
  function goCoach() { try { if (typeof window.cv2Go === 'function') window.cv2Go('cv2coach'); } catch (e) {} }
  function renderHome() {
    var home = document.getElementById('cv2-cv2home-page'); if (!home) return;
    var old = document.getElementById('liw-home'); if (old) old.remove();
    var card = homeCard(); if (!card) return;
    var anchor = home.querySelector('.cv2-seclabel');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor); else home.appendChild(card);
  }

  // ── Coach tab: "Latest feedback" = the replies Omar actually sent ───────────────────────────────────────────────────
  function renderCoach() {
    var page = document.getElementById('cv2-cv2coach-page'); if (!page || !data) return;
    var fb = data.feedback || []; if (!fb.length) return;
    var card = [].slice.call(page.querySelectorAll('.cv2-card')).filter(function (c) { return /Latest feedback/.test(c.textContent) && !c.querySelector('.liw-fb'); })[0];
    if (!card) return;
    [].slice.call(card.children).forEach(function (ch, i) { if (i > 0) ch.remove(); });   // keep the card's own header
    card.appendChild(el('p', { class: 'liw-fb', text: fb[0].text }));
    card.appendChild(el('p', { class: 'liw-fb-meta', text: 'Sent ' + when(fb[0].sentAt) }));
    if (fb.length > 1) {
      var older = el('details', { class: 'liw-older' }, [el('summary', { text: 'Earlier feedback (' + (fb.length - 1) + ')' })]);
      fb.slice(1).forEach(function (f) { older.appendChild(el('p', { class: 'liw-fb', text: when(f.sentAt) + ' · ' + f.text })); });
      card.appendChild(older);
    }
    put('seen', fb[0].sentAt);
  }
  function render() { try { renderHome(); } catch (e) {} try { renderCoach(); } catch (e) {} }

  function load() {
    var tok = null; try { tok = o.getToken(); } catch (e) {}
    if (!tok) return;
    lastLoad = Date.now();
    fetch(o.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'clientWeekGet', storageKey: o.storageKey, token: tok }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) { data = j; render(); } }).catch(function () {});
  }
  function boot(opts) {
    try {
      if (o || !opts || !opts.storageKey || typeof opts.getToken !== 'function' || !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api$/.test(opts.apiUrl || '')) return;
      o = opts; css();
      ['cv2-cv2home-page', 'cv2-cv2coach-page'].forEach(function (id) {
        var n = document.getElementById(id);
        if (n && window.MutationObserver) new MutationObserver(function () {
          if (id === 'cv2-cv2home-page' && !document.getElementById('liw-home')) renderHome();
          if (id === 'cv2-cv2coach-page') renderCoach();
        }).observe(n, { childList: true });
      });
      document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - lastLoad > 3600e3) load(); });
      load();
    } catch (e) {}
  }
  window.LockedInWeek = { boot: boot };
})();
