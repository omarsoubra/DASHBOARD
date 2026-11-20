/* WEEKLY CHECK-IN SHEET (2026-11-20) - the V2 face of the page's own check-in form.
   Loaded by push-client.js (bootCheckin) on V2 client pages. It does NOT save anything itself: every answer is written
   into the page's own fields (input-weight, input-week, input-energy, input-sleep, input-stress, input-feeling = meals
   on plan, input-training, input-notes) and Send calls the page's own saveCheckin(), so the coach dashboard, the
   check-in review and autopilot read exactly the same fields as before.
   What changes for the client: one screen opened from Home / Coach / Progress, the week filled in for them, tap 1-10
   instead of typing, no start weight sitting in the weight box, one tap to use this morning's weigh-in, sleep from
   Apple Health when it is connected.
   Pages without the form-v2 fields or the V2 layer keep their old form (boot does nothing). CSS prefix: lci-. */
(function () {
  'use strict';
  if (window.LockedInCheckin) return;
  var o = null, SK = '', S = null, origScroll = null, origNote = null;
  var IDS = ['input-weight', 'input-week', 'input-energy', 'input-sleep', 'input-stress', 'input-feeling', 'input-training', 'input-notes'];
  var VIEWS = ['front', 'side', 'back'];
  var DAY = 864e5;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function coach() { try { return String((CLIENT_CONFIG.trainer && CLIENT_CONFIG.trainer.name) || (CLIENT_CONFIG.coach && CLIENT_CONFIG.coach.name) || 'Omar').split(' ')[0]; } catch (e) { return 'Omar'; } }
  function ready() {
    return document.body.classList.contains('cv2') && typeof window.saveCheckin === 'function' && typeof window.cv2ScrollToForm === 'function' &&
      !!$('section-tracker') && IDS.every(function (id) { return !!$(id); }) && !!$('log-btn');
  }

  // ── the page's own fields are the only state ─────────────────────────────────────────────────────────────────────
  function val(id) { var e = $(id); return e ? String(e.value || '') : ''; }
  function set(id, v) {
    var e = $(id); if (!e) return;
    e.value = v == null ? '' : String(v);
    try { e.dispatchEvent(new Event('input', { bubbles: true })); } catch (x) {}
    saveDraft();
  }
  function draftKey() { return SK + '_cv2_checkin_draft'; }           // the same draft the V2 layer keeps
  function saveDraft() {
    var f = {}; IDS.forEach(function (id) { var v = val(id); if (v !== '') f[id] = v; });
    if (Object.keys(f).filter(function (k) { return k !== 'input-week'; }).length) lsSet(draftKey(), f);
    else try { localStorage.removeItem(draftKey()); } catch (e) {}
  }
  function restoreDraft() {
    var d = lsGet(draftKey(), null); if (!d) return;
    IDS.forEach(function (id) { if (id === 'input-week') return; var e = $(id); if (e && !e.value && d[id] != null) e.value = d[id]; });
  }
  function hasDraft() { return IDS.some(function (id) { return id !== 'input-week' && val(id) !== ''; }) || !!lsGet(draftKey(), null); }
  function sentInfo() { return lsGet(SK + '_cv2_checkin_sent', null); }

  // ── week: worked out from the program start, like the rest of the V2 layer ─────────────────────────────────────────────
  function weekInfo() {
    var total = 12, wk = null, sure = false;
    try { total = (CLIENT_CONFIG.client && CLIENT_CONFIG.client.durationWeeks) || 12; } catch (e) {}
    try {
      var src = (typeof CANONICAL_START !== 'undefined' && CANONICAL_START) ? CANONICAL_START : ((typeof START_DATE !== 'undefined' && START_DATE) ? START_DATE : null);
      if (src) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(src)), s = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(src);
        var t = new Date(); t.setHours(0, 0, 0, 0); s.setHours(0, 0, 0, 0);
        if (!isNaN(s) && t - s >= 0) wk = Math.min(Math.max(Math.floor((t - s) / (7 * DAY)) + 1, 1), total);
        sure = !!wk && typeof CANONICAL_START !== 'undefined' && !!CANONICAL_START;
      }
    } catch (e) {}
    if (!sure) {                                                  // no start date from the coach: go from their last check-in
      try {
        var last = (lsGet(SK + '_checkins', []) || [])[0], lw = last && parseInt(last.week, 10);
        if (lw > 0) { var gap = Math.max(1, Math.round((Date.now() - (parseInt(localStorage.getItem(SK + '_last_checkin_ts'), 10) || Date.now() - 7 * DAY)) / (7 * DAY))); wk = Math.min(lw + gap, total); }
      } catch (e) {}
    }
    return { week: wk, total: total, sure: sure };
  }

  // ── helpers from the other shared files (all optional) ───────────────────────────────────────────────────────────
  function lastWeigh() {
    try {
      var w = window.LockedInPlus && window.LockedInPlus.lastWeigh && window.LockedInPlus.lastWeigh();
      if (!w || !(w.kg > 25) || Date.now() - w.ms > 3.5 * DAY) return null;
      var d = new Date(w.ms), t = new Date(); t.setHours(0, 0, 0, 0);
      var days = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
      return { kg: w.kg, label: days <= 0 ? 'today\'s' : days === 1 ? 'yesterday\'s' : d.toLocaleDateString('en-AU', { weekday: 'long' }) + '\'s' };
    } catch (e) { return null; }
  }
  function healthSleep() {
    try {
      var s = window.LockedInHealth && window.LockedInHealth.status && window.LockedInHealth.status();
      if (!s || !s.connected) return null;
      var n = (s.days || []).slice(0, 7).map(function (d) { return +d.sleep_min; }).filter(function (m) { return m > 120 && m < 16 * 60; });
      if (n.length < 3) return null;
      var avg = n.reduce(function (a, b) { return a + b; }, 0) / n.length / 60;
      return { hours: Math.round(avg * 2) / 2, nights: n.length };
    } catch (e) { return null; }
  }
  function photos() { try { return (typeof _photoBase64 !== 'undefined' && _photoBase64) || {}; } catch (e) { return {}; } }

  // ── styles ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function css() {
    if ($('lci-css')) return;
    var s = document.createElement('style'); s.id = 'lci-css';
    s.textContent = [
      'body.cv2 #section-tracker .lci-hide.lci-hide{display:none!important}',
      '.lci-entry{background:var(--c-surface,#fff);border:1px solid var(--c-line,#e9e5dd);border-radius:16px;padding:16px;margin:0 0 16px}',
      '.lci-entry p{margin:0 0 12px;font-size:13.5px;color:var(--c-muted,#5d636b);line-height:1.45}',
      '.lci-bd{position:fixed;inset:0;background:rgba(10,12,16,.45);z-index:2147482000;display:flex;align-items:flex-end;justify-content:center}',
      '.lci-sh{background:var(--c-bg,#faf8f4);color:var(--c-text,#16181c);width:min(100%,560px);height:94vh;height:94dvh;display:flex;flex-direction:column;border-radius:22px 22px 0 0;font-family:inherit;animation:lci-up .18s ease-out}',
      '.lci-sh.fin{height:auto}',
      '@keyframes lci-up{from{transform:translateY(24px);opacity:.6}to{transform:translateY(0);opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.lci-sh{animation:none}}',
      '.lci-hd{padding:16px 16px 12px;flex:0 0 auto;border-bottom:1px solid var(--c-line,#e9e5dd)}',
      '.lci-hd h3{margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em}',
      '.lci-hd p{margin:4px 0 0;font-size:13px;color:var(--c-muted,#5d636b)}',
      '.lci-x{float:right;font:inherit;font-size:24px;line-height:1;background:none;border:0;color:var(--c-muted,#5d636b);cursor:pointer;padding:0 4px;margin-top:-2px}',
      '.lci-bdy{padding:4px 16px 16px;overflow:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto}',
      '.lci-ft{flex:0 0 auto;padding:10px 16px calc(14px + env(safe-area-inset-bottom));border-top:1px solid var(--c-line,#e9e5dd);background:var(--c-bg,#faf8f4)}',
      '.lci-q{padding:16px 0;border-bottom:1px solid var(--c-line,#e9e5dd)}.lci-q:last-child{border-bottom:0}',
      '.lci-q h4{margin:0;font-size:15.5px;font-weight:800;letter-spacing:-.01em}.lci-q h4 small{font-size:12px;font-weight:600;color:var(--c-muted,#5d636b);margin-left:6px}',
      '.lci-q .h{margin:3px 0 10px;font-size:13px;color:var(--c-muted,#5d636b)}',
      '.lci-q.err h4{color:var(--c-err,#b3261e)}.lci-q.err .lci-need{display:block}',
      '.lci-need{display:none;font-size:12.5px;font-weight:700;color:var(--c-err,#b3261e);margin-top:8px}',
      '.lci-wk{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700}',
      '.lci-step{display:inline-flex;align-items:center;gap:6px}',
      '.lci-step button{font:inherit;font-size:20px;font-weight:700;line-height:1;width:44px;height:44px;border-radius:12px;border:1px solid var(--c-line,#e9e5dd);background:var(--c-surface,#fff);color:inherit;cursor:pointer}',
      '.lci-step b{min-width:74px;text-align:center;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}',
      '.lci-link{font:inherit;font-size:13px;font-weight:700;background:none;border:0;color:var(--c-accent,#e8552d);padding:6px 0;cursor:pointer}',
      '.lci-kg{display:flex;align-items:baseline;gap:8px}',
      '.lci-kg input{font:inherit;font-size:30px;font-weight:800;letter-spacing:-.02em;width:140px;box-sizing:border-box;background:var(--c-surface,#fff);color:inherit;border:1px solid var(--c-line,#e9e5dd);border-radius:14px;padding:10px 14px;outline:none;font-variant-numeric:tabular-nums}',
      '.lci-kg input:focus,.lci-notes:focus{border-color:var(--c-accent,#e8552d)}.lci-kg span{font-size:16px;font-weight:700;color:var(--c-muted,#5d636b)}',
      '.lci-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:700;background:var(--c-surface,#fff);border:1px solid var(--c-line,#e9e5dd);border-radius:999px;padding:8px 12px;margin-top:10px;color:inherit;cursor:pointer}',
      '.lci-chip i{font-style:normal;color:var(--c-accent,#e8552d)}',
      '.lci-sc{display:grid;grid-template-columns:repeat(10,1fr);gap:4px}',
      '.lci-sc button{font:inherit;font-size:15px;font-weight:700;height:44px;padding:0;border-radius:10px;border:1px solid var(--c-line,#e9e5dd);background:var(--c-surface,#fff);color:inherit;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.lci-sc button[aria-pressed="true"]{background:var(--c-text,#16181c);border-color:var(--c-text,#16181c);color:var(--c-bg,#faf8f4)}',
      '.lci-ends{display:flex;justify-content:space-between;font-size:11.5px;color:var(--c-muted,#5d636b);margin-top:5px}',
      '.lci-tag{font-size:12px;color:var(--c-muted,#5d636b);margin-top:8px}',
      '.lci-ph{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
      '.lci-ph button{font:inherit;font-size:12.5px;font-weight:700;aspect-ratio:1/1;border-radius:12px;border:1.5px dashed var(--c-line2,#d8d3c9);background:var(--c-surface,#fff) center/cover no-repeat;color:var(--c-muted,#5d636b);cursor:pointer;position:relative;overflow:hidden;padding:0}',
      '.lci-ph button.has{border-style:solid;border-color:var(--c-ok,#0f7a48);color:#fff}.lci-ph button.has span{position:absolute;left:0;right:0;bottom:0;padding:5px;background:rgba(0,0,0,.55);font-size:11.5px}',
      '.lci-notes{width:100%;box-sizing:border-box;font:inherit;font-size:16px;line-height:1.45;min-height:96px;background:var(--c-surface,#fff);color:inherit;border:1px solid var(--c-line,#e9e5dd);border-radius:12px;padding:12px 13px;outline:none;resize:vertical}',
      '.lci-btn{display:block;width:100%;font:inherit;font-size:16px;font-weight:800;border:0;border-radius:14px;padding:15px;background:var(--c-accent,#e8552d);color:#fff;cursor:pointer}',
      '.lci-btn[disabled]{opacity:.55}',
      '.lci-msg{font-size:13px;font-weight:700;color:var(--c-err,#b3261e);margin:0 0 8px;display:none}.lci-msg.show{display:block}',
      '.lci-done{text-align:center;padding:30px 16px calc(20px + env(safe-area-inset-bottom))}',
      '.lci-done .ok{width:56px;height:56px;border-radius:50%;background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48);display:inline-flex;align-items:center;justify-content:center;font-size:28px;font-weight:800}',
      '.lci-done h4{margin:14px 0 4px;font-size:21px;font-weight:800;letter-spacing:-.02em}.lci-done p{margin:2px 0 6px;font-size:14px;color:var(--c-muted,#5d636b)}',
      '.lci-done p.n{color:var(--c-text,#16181c);font-weight:700;font-size:15px;margin-bottom:18px}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Progress page: the long form becomes one card with a button ───────────────────────────────────────────────────
  function tidyProgress() {
    var sec = $('section-tracker'); if (!sec) return;
    var hide = [].slice.call(sec.querySelectorAll('.tracker-grid'));
    var n = $('input-notes'); if (n && n.parentNode && n.parentNode !== sec) hide.push(n.parentNode);
    var ph = $('photo-btn-front'), box = ph && ph.closest('div[style*="dashed"]'); if (box) hide.push(box);
    hide.push($('log-btn'));
    hide.forEach(function (e) { if (e) e.classList.add('lci-hide'); });
    var card = $('lci-entry');
    if (!card) {
      card = document.createElement('div'); card.id = 'lci-entry'; card.className = 'lci-entry';
      var first = sec.querySelector('.tracker-grid'); if (!first) return;
      first.parentNode.insertBefore(card, first);
    }
    /* The check-in sits first on Progress, above the trends, not under them. */
    var top = $('cv2-progress-top'), head = $('cv2-checkin-anchor');
    if (top && top.parentNode && card.nextSibling !== top) {
      if (head) top.parentNode.insertBefore(head, top);
      top.parentNode.insertBefore(card, top);
    }
    var s = sentInfo(), recent = s && Date.now() - s.ts < 3 * DAY, draft = hasDraft();
    card.innerHTML = '<p>' + (draft ? 'You started this week\'s check-in. Your answers are saved on this phone.'
      : 'Weight · Meals on plan · Training · Sleep. About a minute, and ' + esc(coach()) + ' replies by message.') + '</p>' +
      '<button type="button" class="lci-btn" id="lci-open">' + (draft ? 'Finish check-in' : recent ? 'Send another check-in' : 'Start check-in') + '</button>';
    $('lci-open').onclick = function () { open(); };
  }

  // ── sheet ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function close() {
    var b = $('lci-bd'); if (b) b.remove();
    document.removeEventListener('keydown', onKey); S = null;
    try { tidyProgress(); } catch (e) {}
    try { if (typeof window.renderHome === 'function') window.renderHome(); } catch (e) {}
  }
  function onKey(e) { if (e.key === 'Escape' && !(S && S.sending)) close(); }

  function scale(id, lo, hi) {
    var cur = parseInt(val(id), 10) || 0, h = '<div class="lci-sc" data-scale="' + id + '" role="group">';
    for (var i = 1; i <= 10; i++) h += '<button type="button" data-v="' + i + '" aria-pressed="' + (cur === i) + '">' + i + '</button>';
    return h + '</div><div class="lci-ends"><span>' + lo + '</span><span>' + hi + '</span></div>';
  }
  function q(key, title, hint, body, opt) {
    return '<div class="lci-q" data-q="' + key + '"><h4>' + title + (opt ? '<small>optional</small>' : '') + '</h4>' + (hint ? '<div class="h">' + hint + '</div>' : '<div class="h" style="margin-bottom:6px"></div>') + body +
      (opt ? '' : '<div class="lci-need">' + (key === 'weight' ? 'Add your weight.' : 'Tap a number.') + '</div>') + '</div>';
  }
  function weekHtml() {
    var w = S.wk, cur = parseInt(val('input-week'), 10) || 0;
    if (S.weekEdit || !cur) {
      return '<div class="lci-wk"><span>Week</span><span class="lci-step"><button type="button" data-wk="-1" aria-label="Earlier week">−</button><b>' + (cur || 1) + '</b><button type="button" data-wk="1" aria-label="Later week">+</button></span><span>of ' + w.total + '</span></div>';
    }
    return '<div class="lci-wk"><span>Week ' + cur + ' of ' + w.total + '</span><button type="button" class="lci-link" id="lci-wkedit">Change</button></div>';
  }
  function sleepHtml() {
    var v = parseFloat(val('input-sleep'));
    return '<span class="lci-step"><button type="button" data-sl="-0.5" aria-label="Less sleep">−</button><b id="lci-slv">' + (v ? (v % 1 ? v.toFixed(1) : v) + ' h' : '—') + '</b><button type="button" data-sl="0.5" aria-label="More sleep">+</button></span>' +
      (S.sleepFrom && v === S.sleepFrom.hours ? '<div class="lci-tag">From Apple Health · average of your last ' + S.sleepFrom.nights + ' nights</div>' : '');
  }
  function photoHtml() {
    var p = photos();
    return '<div class="lci-ph">' + VIEWS.map(function (v) {
      var has = !!p[v], name = v.charAt(0).toUpperCase() + v.slice(1);
      return '<button type="button" data-ph="' + v + '"' + (has ? ' class="has" style="background-image:url(' + esc(p[v]) + ')"' : '') + '><span>' + (has ? name + ' ✓' : name) + '</span></button>';
    }).join('') + '</div>';
  }
  function weighChip() {
    var w = S.weigh; if (!w || parseFloat(val('input-weight')) === w.kg) return '';
    return '<button type="button" class="lci-chip" id="lci-usew"><i>↑</i>Use ' + esc(w.label) + ' weigh-in · ' + w.kg.toFixed(1) + ' kg</button>';
  }

  function render() {
    var bd = $('lci-bd'); if (!bd) return;
    var C = esc(coach());
    bd.querySelector('.lci-sh').className = 'lci-sh';
    bd.querySelector('.lci-sh').innerHTML =
      '<div class="lci-hd"><button type="button" class="lci-x" aria-label="Close">×</button><h3>Weekly check-in</h3><p>Goes straight to ' + C + '. Your answers save as you go.</p></div>' +
      '<div class="lci-bdy">' +
        '<div class="lci-q" data-q="week" id="lci-week">' + weekHtml() + '</div>' +
        q('weight', 'Your weight', 'This morning, before food.', '<div class="lci-kg"><input id="lci-kg" type="number" inputmode="decimal" step="0.1" min="25" max="350" placeholder="0.0" value="' + esc(val('input-weight')) + '" aria-label="Weight in kilograms"><span>kg</span></div><div id="lci-chipbox">' + weighChip() + '</div>') +
        q('feeling', 'Meals on plan', 'How closely did you eat your plan this week?', scale('input-feeling', 'Barely', 'Every meal')) +
        q('training', 'Training', 'How many of your sessions did you get done as planned?', scale('input-training', 'Missed most', 'All of them')) +
        q('sleep', 'Sleep', 'Average hours a night.', '<div id="lci-sleep">' + sleepHtml() + '</div>', true) +
        q('energy', 'Energy', '', scale('input-energy', 'Flat', 'Great'), true) +
        q('stress', 'Stress', '', scale('input-stress', 'Calm', 'Maxed out'), true) +
        q('photos', 'Progress photos', 'Front, side and back. Only ' + C + ' sees them.', '<div id="lci-photos">' + photoHtml() + '</div>', true) +
        q('notes', 'Anything ' + C + ' should know?', 'Injuries, schedule changes, how training felt.', '<textarea class="lci-notes" id="lci-notes" placeholder="Type here…">' + esc(val('input-notes')) + '</textarea>', true) +
      '</div>' +
      '<div class="lci-ft"><p class="lci-msg" id="lci-msg"></p><button type="button" class="lci-btn" id="lci-send">Send check-in to ' + C + '</button></div>';
    wire();
  }

  function wire() {
    var bd = $('lci-bd');
    bd.querySelector('.lci-x').onclick = function () { if (!(S && S.sending)) close(); };
    bd.onclick = function (e) { if (e.target === bd && !(S && S.sending)) close(); };
    var kg = $('lci-kg');
    kg.oninput = function () { set('input-weight', kg.value); $('lci-chipbox').innerHTML = weighChip(); wireChip(); clearErr('weight'); };
    wireChip(); wireWeek(); wireSleep(); wirePhotos();
    [].forEach.call(bd.querySelectorAll('.lci-sc'), function (g) {
      g.onclick = function (e) {
        var b = e.target.closest('button[data-v]'); if (!b) return;
        var id = g.getAttribute('data-scale'), was = b.getAttribute('aria-pressed') === 'true';
        var required = id === 'input-feeling' || id === 'input-training';
        var v = was && !required ? '' : b.getAttribute('data-v');
        set(id, v);
        [].forEach.call(g.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(v !== '' && x.getAttribute('data-v') === v)); });
        clearErr(id.replace('input-', ''));
      };
    });
    var nt = $('lci-notes'); nt.oninput = function () { set('input-notes', nt.value); };
    $('lci-send').onclick = send;
  }
  function wireChip() { var c = $('lci-usew'); if (c) c.onclick = function () { $('lci-kg').value = S.weigh.kg.toFixed(1); set('input-weight', S.weigh.kg.toFixed(1)); $('lci-chipbox').innerHTML = ''; clearErr('weight'); }; }
  function wireWeek() {
    var box = $('lci-week'), ed = $('lci-wkedit');
    if (ed) ed.onclick = function () { S.weekEdit = true; box.innerHTML = weekHtml(); wireWeek(); };
    [].forEach.call(box.querySelectorAll('button[data-wk]'), function (b) {
      b.onclick = function () {
        var cur = parseInt(val('input-week'), 10) || 1, n = Math.min(Math.max(cur + (+b.getAttribute('data-wk')), 1), S.wk.total);
        S.weekEdit = true; set('input-week', n); box.innerHTML = weekHtml(); wireWeek();
      };
    });
  }
  function wireSleep() {
    var box = $('lci-sleep');
    [].forEach.call(box.querySelectorAll('button[data-sl]'), function (b) {
      b.onclick = function () {
        var cur = parseFloat(val('input-sleep')), n = cur ? cur + (+b.getAttribute('data-sl')) : 7;
        set('input-sleep', Math.min(Math.max(n, 3), 14)); box.innerHTML = sleepHtml(); wireSleep();
      };
    });
  }
  function wirePhotos() {
    var box = $('lci-photos');
    [].forEach.call(box.querySelectorAll('button[data-ph]'), function (b) {
      b.onclick = function () {
        /* Our own picker with no "capture": on iPhone that offers Photo Library, Take Photo and Choose File. The page's
           own handler resizes the photo and keeps it for saveCheckin(). */
        var v = b.getAttribute('data-ph'), inp = $('lci-photo-' + v);
        if (typeof window.handlePhotoPicked !== 'function') return;
        if (!inp) {
          inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.id = 'lci-photo-' + v; inp.style.display = 'none';
          inp.addEventListener('change', function (e) {
            try { window.handlePhotoPicked(e, v); } catch (x) {}
            var n = 0, t = setInterval(function () { if (!$('lci-photos') || ++n > 60) return clearInterval(t); if (photos()[v]) { clearInterval(t); $('lci-photos').innerHTML = photoHtml(); wirePhotos(); } }, 150);
          });
          document.body.appendChild(inp);
        }
        inp.value = '';
        inp.click();
      };
    });
  }
  function clearErr(k) { var e = document.querySelector('#lci-bd .lci-q[data-q="' + k + '"]'); if (e) e.classList.remove('err'); var m = $('lci-msg'); if (m) m.classList.remove('show'); }
  function msg(t) { var m = $('lci-msg'); if (m) { m.textContent = t; m.classList.add('show'); } }

  function open(opts) {
    if (!o || $('lci-bd')) return;
    css();
    S = { sending: false, weekEdit: false, wk: weekInfo(), weigh: null, sleepFrom: null };
    S.weekEdit = !S.wk.sure;
    restoreDraft();
    if (S.wk.week && !val('input-week')) $('input-week').value = S.wk.week;        // not a draft answer: no event, no draft
    S.weigh = lastWeigh();
    S.sleepFrom = healthSleep();
    if (S.sleepFrom && !val('input-sleep')) $('input-sleep').value = S.sleepFrom.hours;
    var bd = document.createElement('div'); bd.className = 'lci-bd'; bd.id = 'lci-bd';
    bd.innerHTML = '<div class="lci-sh" role="dialog" aria-modal="true" aria-label="Weekly check-in"></div>';
    document.body.appendChild(bd);
    document.addEventListener('keydown', onKey);
    render();
    if (opts && opts.notes) setTimeout(function () { var n = $('lci-notes'); if (n) { n.scrollIntoView({ block: 'center' }); n.focus({ preventScroll: true }); } }, 80);
  }

  async function send() {
    if (!S || S.sending) return;
    var kg = parseFloat(val('input-weight')), miss = [];
    if (!(kg > 25 && kg < 350)) miss.push('weight');
    if (!(parseInt(val('input-feeling'), 10) > 0)) miss.push('feeling');
    if (!(parseInt(val('input-training'), 10) > 0)) miss.push('training');
    if (!(parseInt(val('input-week'), 10) > 0)) { S.weekEdit = true; set('input-week', 1); $('lci-week').innerHTML = weekHtml(); wireWeek(); }
    if (miss.length) {
      miss.forEach(function (k) { var e = document.querySelector('#lci-bd .lci-q[data-q="' + k + '"]'); if (e) e.classList.add('err'); });
      var f = document.querySelector('#lci-bd .lci-q.err'); if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return msg(miss.length === 1 ? 'One answer still needed.' : miss.length + ' answers still needed.');
    }
    S.sending = true;
    var btn = $('lci-send'), nPh = VIEWS.filter(function (v) { return photos()[v]; }).length;
    btn.disabled = true; btn.textContent = nPh ? 'Sending with ' + nPh + ' photo' + (nPh === 1 ? '' : 's') + '…' : 'Sending…';
    var before = (sentInfo() || {}).ts || 0;
    var snap = { week: val('input-week'), kg: kg, meals: val('input-feeling'), training: val('input-training') };
    try { await window.saveCheckin(); } catch (e) {}
    if (!S) return;
    S.sending = false;
    var after = (sentInfo() || {}).ts || 0;
    if (after && after !== before) return done(snap);
    render();                                                    // the page put the answers back in its fields
    var st = $('send-status'), why = st && st.style.display !== 'none' ? String(st.textContent || '') : '';
    msg(/^Not sent/.test(why) ? why.replace(/ Your answers are still in the form; tap Send again\.?/, ' Your answers are saved. Tap send again.') : 'Not sent. Check your connection and tap send again. Your answers are saved.');
  }
  function done(s) {
    var bd = $('lci-bd'); if (!bd) return;
    var sh = bd.querySelector('.lci-sh'); sh.className = 'lci-sh fin';
    sh.innerHTML = '<div class="lci-done"><div class="ok">✓</div><h4>Check-in sent</h4><p>' + esc(coach()) + ' will review it and reply by message.</p>' +
      '<p class="n">Week ' + esc(s.week) + ' · ' + s.kg.toFixed(1) + ' kg · Meals ' + esc(s.meals) + '/10 · Training ' + esc(s.training) + '/10</p>' +
      '<button type="button" class="lci-btn" id="lci-donebtn">Done</button></div>';
    $('lci-donebtn').onclick = close;
  }

  function boot(opts) {
    try {
      if (o) return;
      if (!ready()) return;                                     // older pages keep their own form
      o = opts || {};
      SK = o.storageKey || (CLIENT_CONFIG.client && CLIENT_CONFIG.client.storageKey) || '';
      if (!SK) { o = null; return; }
      css();
      origScroll = window.scrollToCheckin; origNote = window.cv2NoteToCoach;
      window.scrollToCheckin = function () { var b = $('sunday-checkin-reminder'); if (b) b.style.display = 'none'; open(); };
      window.cv2NoteToCoach = function () { open({ notes: true }); };
      tidyProgress();
      /* The V2 layer redraws Progress when it is opened; keep the card's wording fresh. */
      if (typeof window.showSection === 'function') {
        var _s = window.showSection;
        window.showSection = function (id) { var r = _s.apply(this, arguments); if (id === 'tracker') { try { tidyProgress(); } catch (e) {} } return r; };
      }
    } catch (e) {}
  }

  window.LockedInCheckin = { boot: boot, open: open, close: close, active: function () { return !!o; } };
})();
