/* ==========================================================================
   LOCKED IN · Log food (Omar 2026-11-19: "our next project")
   --------------------------------------------------------------------------
   Loaded by push-client.js on V2 client pages. Adds "Log food" to the
   Nutrition screen: search everyday foods (FSANZ AUSNUT 2023), the plan's
   own products and the eating-out chains, scan a barcode (Open Food Facts),
   or type the numbers off a label. Logged food is extra to the plan meals
   and is added to the day's totals on Nutrition and Home.

   - No page (shell) edits. Totals are added to the page's own figures after
     each page render; every patch is idempotent.
   - Saves on the phone first, then through the page's own cloudWrite('meal').
   - On for every V2 page since 2026-11-19 (pilot on Omar's page first). OFF lists the keys that stay without it.
   - The barcode lookup sends the barcode number only. Nothing about the client.
   - Every entry point is try/catch guarded so the page never breaks.
   ========================================================================== */
(function () {
  'use strict';
  if (window.LockedInFood) return;
  var OFF = { isaac_alameddine: 1 };   // rolled out to every V2 page 2026-11-19 (Omar: "Build 2 first then 1"); keys here stay without it
  var o = null, BASE = '';
  var DATA = null, dataP = null, CHAINS = null, chainsP = null, INDEX = null;
  var KJ = 4.184, KEEP_DAYS = 90;

  // ── helpers ────────────────────────────────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { n.addEventListener(e, attrs.on[e]); });
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var LS = function (k) { return 'lif_' + k + '_' + (o ? o.storageKey : ''); };
  function lsGet(k, d) { try { var v = localStorage.getItem(LS(k)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsPut(k, v) { try { localStorage.setItem(LS(k), JSON.stringify(v)); return true; } catch (e) { return false; } }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; }
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function int(x) { return Math.round(Number(x) || 0).toLocaleString('en-AU'); }
  function unInt(s) { var n = parseFloat(String(s || '').replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; }
  function localDay(t) { var d = new Date(t); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function today() { return localDay(Date.now()); }
  function toast(msg) {
    var old = document.querySelector('.lif-toast'); if (old) old.remove();
    var t = el('div', { class: 'lif-toast', role: 'status', text: msg }); document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 2800);
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('load_failed')); };
      document.head.appendChild(s);
    });
  }

  function css() {
    if (document.getElementById('lif-css')) return;
    var s = document.createElement('style'); s.id = 'lif-css';
    s.textContent = [
      '.lif-toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 92px);transform:translateX(-50%);z-index:2147483100;background:#16181c;color:#fff;font:600 14px/1.3 inherit;font-family:inherit;padding:11px 16px;border-radius:999px;box-shadow:0 12px 30px -10px rgba(0,0,0,.5);max-width:88vw;text-align:center}',
      '#lif-box{margin:12px 0 0}',
      '.lif-add{display:flex;align-items:center;gap:12px;width:100%;text-align:left;font:inherit;margin:0;padding:13px 14px;border-radius:var(--c-r,16px);border:0;background:var(--c-text,#16181c);color:#fff;cursor:pointer}',
      '.lif-add .ic{flex:0 0 auto;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.16);display:grid;place-items:center;font-size:19px;font-weight:700;line-height:1}',
      '.lif-add b{display:block;font-size:15px;font-weight:800}.lif-add small{display:block;font-size:12.5px;opacity:.72;margin-top:1px}',
      '.lif-list{margin:10px 0 0;background:var(--c-surface,#fff);border:1px solid var(--c-line,#e7e2d9);border-radius:var(--c-r,16px);overflow:hidden}',
      '.lif-list h4{margin:0;padding:11px 14px 4px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--c-muted,#5d636b);display:flex;justify-content:space-between}',
      '.lif-row{display:flex;align-items:center;gap:10px;padding:10px 6px 10px 14px;border-top:1px solid var(--c-line,#e7e2d9)}.lif-list h4 + .lif-row{border-top:0}',
      '.lif-row .tx{flex:1 1 auto;min-width:0}.lif-row b{display:block;font-size:14.5px;font-weight:700;color:var(--c-text,#16181c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lif-row small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin-top:1px}',
      '.lif-row .kc{flex:0 0 auto;text-align:right;font-weight:800;font-size:14.5px;font-variant-numeric:tabular-nums;color:var(--c-text,#16181c)}.lif-row .kc small{font-weight:600}',
      '.lif-rm{flex:0 0 auto;font:inherit;font-size:20px;line-height:1;width:36px;height:36px;border:0;background:none;color:var(--c-muted,#5d636b);cursor:pointer;border-radius:50%}',
      '.lif-warnchip{display:inline-block;font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;background:var(--c-warn-tint,#fff4e0);color:var(--c-warn,#9a5b00);margin-left:6px;vertical-align:1px}',
      '.lif-bd{position:fixed;inset:0;background:rgba(10,12,16,.45);z-index:2147482000;display:flex;align-items:flex-end;justify-content:center}',
      '.lif-sh{background:var(--c-bg,#faf8f4);color:var(--c-text,#16181c);width:min(100%,560px);height:92vh;max-height:92vh;overflow:auto;border-radius:22px 22px 0 0;padding:16px 16px calc(20px + env(safe-area-inset-bottom));font-family:inherit;-webkit-overflow-scrolling:touch;box-sizing:border-box}',
      '.lif-sh h3{margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em}.lif-sh .sub{margin:4px 0 12px;font-size:13px;color:var(--c-muted,#5d636b)}',
      '.lif-x{float:right;font:inherit;font-size:24px;line-height:1;background:none;border:0;color:var(--c-muted,#5d636b);cursor:pointer;padding:2px 6px;margin:-2px -4px 0 0}',
      '.lif-search{display:flex;gap:8px;margin:0 0 10px}',
      '.lif-in{flex:1 1 auto;width:100%!important;min-width:0;margin:0;box-sizing:border-box;font:inherit;font-size:16px;font-weight:600;padding:12px;border-radius:12px;border:1px solid var(--c-line2,#d9d3c8);background:var(--c-surface,#fff);color:var(--c-text,#16181c);box-shadow:none}',
      '.lif-btn{flex:0 0 auto;width:auto!important;margin:0;font:inherit;font-weight:800;font-size:14.5px;padding:12px 16px;border-radius:12px;border:0;background:var(--c-accent,#e8542e);color:#fff;cursor:pointer;white-space:nowrap}',
      '.lif-btn.wide{display:block;width:100%!important;padding:14px 16px;font-size:16px;margin-top:14px}',
      '.lif-btn.ghost{background:var(--c-surface,#fff);color:var(--c-text,#16181c);border:1px solid var(--c-line2,#d9d3c8)}',
      '.lif-btn[disabled]{opacity:.5}',
      '.lif-two{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}',
      '.lif-two .lif-btn{width:100%!important;padding:12px 8px;font-size:14px}',
      '.lif-lab{margin:14px 2px 8px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--c-muted,#5d636b)}',
      '.lif-opt{display:flex;justify-content:space-between;gap:10px;align-items:center;width:100%;text-align:left;font:inherit;padding:11px 12px;margin:0 0 6px;border-radius:14px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:inherit;cursor:pointer;box-sizing:border-box}',
      '.lif-opt .tx{min-width:0}.lif-opt b{display:block;font-size:14.5px;font-weight:700;line-height:1.3}.lif-opt small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin-top:2px}',
      '.lif-opt .k{flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums;font-weight:800;font-size:14px}.lif-opt .k small{font-weight:600}',
      '.lif-empty{padding:18px 6px;font-size:14px;color:var(--c-muted,#5d636b);text-align:center;line-height:1.5}',
      '.lif-back{font:inherit;font-size:13.5px;font-weight:700;background:none;border:0;color:var(--c-accent,#e8542e);cursor:pointer;padding:0;margin:0 0 10px}',
      '.lif-chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 0}',
      '.lif-chip{font:inherit;font-size:13px;font-weight:700;padding:7px 12px;border-radius:999px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:var(--c-muted,#5d636b);cursor:pointer}',
      '.lif-chip.on{background:var(--c-text,#16181c);color:#fff;border-color:var(--c-text,#16181c)}',
      '.lif-amt{display:flex;gap:8px;align-items:center;margin-top:12px}.lif-amt .lif-in{font-size:20px;font-weight:800;max-width:130px;text-align:center}.lif-amt span{font-size:14px;font-weight:700;color:var(--c-muted,#5d636b)}',
      '.lif-step{font:inherit;font-size:22px;font-weight:700;width:46px;height:46px;border-radius:12px;border:1px solid var(--c-line2,#d9d3c8);background:var(--c-surface,#fff);color:var(--c-text,#16181c);cursor:pointer}',
      '.lif-tot{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr;gap:6px;margin-top:14px}',
      '.lif-tot div{background:var(--c-surface,#fff);border:1px solid var(--c-line,#e7e2d9);border-radius:12px;padding:9px 8px;text-align:center}',
      '.lif-tot b{display:block;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums}.lif-tot span{display:block;font-size:11.5px;font-weight:700;color:var(--c-muted,#5d636b);margin-top:1px}',
      '.lif-note{font-size:12.5px;line-height:1.45;color:var(--c-muted,#5d636b);margin:10px 2px 0}',
      '.lif-flag{margin:12px 0 0;padding:10px 12px;border-radius:12px;background:var(--c-warn-tint,#fff4e0);color:var(--c-warn,#9a5b00);font-size:13.5px;font-weight:700}',
      '.lif-form label{display:block;font-size:12.5px;font-weight:700;color:var(--c-muted,#5d636b);margin:10px 2px 4px}',
      '.lif-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.lif-cam{position:relative;border-radius:16px;overflow:hidden;background:#000;aspect-ratio:4/3;margin:0 0 12px}',
      '.lif-cam video{width:100%;height:100%;object-fit:cover;display:block}',
      '.lif-cam:after{content:"";position:absolute;left:8%;right:8%;top:30%;bottom:30%;border:3px solid rgba(255,255,255,.92);border-radius:14px;box-shadow:0 0 0 2000px rgba(0,0,0,.34);transition:border-color .12s}',
      '.lif-cam.hit:after{border-color:#35d07f;box-shadow:0 0 0 2000px rgba(0,0,0,.34),0 0 22px rgba(53,208,127,.9)}',
      '.lif-cam .ok{position:absolute;left:0;right:0;bottom:10px;z-index:2;text-align:center;color:#fff;font-size:15px;font-weight:800;text-shadow:0 1px 6px rgba(0,0,0,.7)}',
      '.lif-torch{position:absolute;top:10px;right:10px;z-index:2;font:inherit;font-size:13px;font-weight:800;padding:8px 12px;border-radius:999px;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer}',
      '.lif-torch.on{background:#fff;color:#16181c}',
      '.lif-cam .msg{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:14px;text-align:center;padding:20px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── stores ───────────────────────────────────────────────────────────────────────────────
  function logAll() { return lsGet('log', {}) || {}; }
  function logFor(day) { return (logAll()[day] || []).slice(); }
  function logSave(all) {
    var cut = localDay(Date.now() - KEEP_DAYS * 864e5);
    Object.keys(all).forEach(function (d) { if (d < cut || !all[d] || !all[d].length) delete all[d]; });
    return lsPut('log', all);
  }
  function myFoods() { return lsGet('my', []) || []; }
  function recents() { return lsGet('recent', []) || []; }
  function pushRecent(food, amt, ui) {
    var r = recents().filter(function (x) { return x.f.n !== food.n; });
    r.unshift({ f: slim(food), a: amt, u: ui });
    lsPut('recent', r.slice(0, 20));
  }
  function slim(f) { return { n: f.n, b: f.b, k: f.k, p: f.p, c: f.c, f: f.f, fl: f.fl || 0, ms: f.ms || [], u: f.u || '', src: f.src, code: f.code || '' }; }
  function saveMy(food) {
    var m = myFoods().filter(function (x) { return x.n.toLowerCase() !== food.n.toLowerCase() && !(food.code && x.code === food.code); });
    var s = slim(food); s.src = 'my'; m.unshift(s);
    lsPut('my', m.slice(0, 200));
    return s;
  }

  // ── data (loaded when the sheet first opens) ─────────────────────────────────────────────────
  var SRC_LABEL = { my: 'My food', plan: 'From your plan', db: 'Everyday food', chain: 'Eating out', off: 'Scanned' };
  var PORK = /\b(pork|bacon|ham|salami|pepperoni|prosciutto|chorizo|pancetta|lard)\b/i;
  function norm(s) { return ' ' + String(s).toLowerCase().replace(/yogurt/g, 'yoghurt').replace(/[^a-z0-9%]+/g, ' ').trim(); }
  function loadData() {
    if (DATA) return Promise.resolve(DATA);
    if (dataP) return dataP;
    dataP = (window.LockedInFoodData ? Promise.resolve() : loadScript(BASE + 'food-data.js')).then(function () {
      var d = window.LockedInFoodData; if (!d || !d.g) throw new Error('no_data');
      var out = [];
      (d.p || []).forEach(function (x) { out.push({ n: x[0], b: x[1], k: x[2], p: x[3], c: x[4], f: x[5], fl: x[6], u: x[7] || '', ms: [], src: 'plan' }); });
      d.g.forEach(function (x) { out.push({ n: x[0], b: 'g', k: x[1], p: x[2], c: x[3], f: x[4], fl: x[5], ms: x[6] || [], src: 'db' }); });
      out.forEach(function (f) { f._l = norm(f.n); });
      INDEX = out; DATA = d; return d;
    }).catch(function (e) { dataP = null; throw e; });
    return dataP;
  }
  function loadChains() {
    if (CHAINS) return Promise.resolve(CHAINS);
    if (chainsP) return chainsP;
    chainsP = (window.LockedInEatOutData ? Promise.resolve() : loadScript(BASE + 'eatout-data.js')).then(function () {
      var d = window.LockedInEatOutData, out = [];
      ((d && d.chains) || []).forEach(function (ch) { (ch.g || []).forEach(function (g) { (g.i || []).forEach(function (it) {
        var f = { n: ch.name + ': ' + it[0], b: 'u', k: it[1], p: it[2], c: it[3], f: it[4], fl: 0, u: 'serve', ms: [], src: 'chain' };
        f._l = norm(f.n); out.push(f);
      }); }); });
      CHAINS = out; return out;
    }).catch(function () { chainsP = null; CHAINS = []; return CHAINS; });
    return chainsP;
  }
  var RANK = { my: 0, plan: 1, db: 2, off: 2, chain: 3 };
  function search(q, limit) {
    var toks = norm(q).trim().split(' ').filter(Boolean).map(function (t) { return t.length > 3 ? t.replace(/(es|s)$/, '') : t; });
    if (!toks.length) return [];
    var pools = [myFoods().map(function (f) { f._l = f._l || norm(f.n); f.src = 'my'; return f; }), INDEX || [], CHAINS || []];
    var hits = [];
    pools.forEach(function (pool) {
      for (var i = 0; i < pool.length; i++) {
        var f = pool[i], l = f._l, ok = true, first = 0;
        for (var j = 0; j < toks.length; j++) { var at = l.indexOf(' ' + toks[j]); if (at < 0) { ok = false; break; } if (j === 0) first = at; }
        if (!ok) continue;
        var s = RANK[f.src] * 2 + (first === 0 ? 0 : 3 + first / 40) + l.length / 60;
        if (f.src === 'db' && first === 0 && /\b(un)?peeled( or unpeeled)? raw$/.test(l)) s -= 1.5;   // plain fruit and veg first
        hits.push({ f: f, s: s });
      }
    });
    hits.sort(function (a, b) { return a.s - b.s; });
    return hits.slice(0, limit || 40).map(function (h) { return h.f; });
  }

  // ── amounts ──────────────────────────────────────────────────────────────────────────────
  /* units: [label, grams-or-ml per one, isBase]. A 'u' food has one unit (the serve). */
  function unitsOf(f) {
    if (f.b === 'u') return [[f.u || 'serve', null]];
    if (f.b === 'm') return [['ml', 1], ['cup (250 ml)', 250]];
    var u = [['g', 1]];
    (f.ms || []).forEach(function (m) { if (m && m[1] > 0) u.push([String(m[0]).replace(/^1 /, ''), m[1]]); });
    return u;
  }
  function calc(f, amt, unit) {
    var a = num(amt); if (!(a > 0)) return null;
    var x = f.b === 'u' ? a : a * unit[1] / 100;
    if (!(x > 0) || x > 400) return null;
    var base = f.b === 'u' ? '' : f.b === 'm' ? 'ml' : 'g';
    var label = f.b === 'u' ? (a === 1 ? '1 ' : r1(a) + ' × ') + unit[0]
      : unit[1] === 1 ? r1(a) + ' ' + base
        : r1(a) + ' × ' + unit[0] + ' (' + Math.round(a * unit[1]) + ' ' + base + ')';
    return { k: Math.round(f.k * x), p: r1(f.p * x), c: r1(f.c * x), f: r1(f.f * x), label: label };
  }
  function perLine(f) {
    var base = f.b === 'u' ? 'per ' + (f.u || 'serve') : f.b === 'm' ? 'per 100 ml' : 'per 100 g';
    return int(f.k) + ' kcal · P ' + r1(f.p) + ' g · ' + base;
  }

  // ── the viewed day (read from the page) ──────────────────────────────────────────────────────
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* The page's week bar counts weeks from the client's start date, so its printed dates can sit a week off the real
     calendar (and stop moving once the program is over). The week that holds the "today" button IS this real week, so
     days are placed from today; other weeks are placed the same number of weeks away as the bar says. */
  var curStart = null;   // the date the bar prints for the week that holds today
  function navStart(box) {
    var nav = box.querySelector('.cv2-weeknav b'), m = nav && /·\s*(\d{1,2})\s+([A-Za-z]{3})/.exec(nav.textContent || '');
    var mo = m ? MON.indexOf(m[2]) : -1; if (mo < 0) return null;
    var now = new Date(), best = null;
    [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].forEach(function (y) {
      var d = new Date(y, mo, +m[1], 12); if (best === null || Math.abs(d - now) < Math.abs(best - now)) best = d;
    });
    return best;
  }
  function viewedDay() {
    try {
      var box = document.getElementById('cv2-nutri'); if (!box) return today();
      var on = box.querySelector('.cv2-day.on'); if (!on) return today();
      if (on.classList.contains('today')) { curStart = navStart(box) || curStart; return today(); }
      var days = Array.prototype.slice.call(box.querySelectorAll('.cv2-day')), idx = days.indexOf(on); if (idx < 0) return null;
      var ti = (new Date().getDay() + 6) % 7, ns = navStart(box), weeks = 0;
      if (box.querySelector('.cv2-day.today')) { if (ns) curStart = ns; }
      else { if (!ns || !curStart) return null; weeks = Math.round((ns - curStart) / (7 * 864e5)); if (!weeks) return null; }
      var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + weeks * 7 + (idx - ti));
      return localDay(d.getTime());
    } catch (e) { return null; }
  }
  function dayLabel(day) {
    if (day === today()) return 'today';
    try { return new Date(day + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }); } catch (e) { return day; }
  }
  function sumOf(list) { var t = { k: 0, p: 0, c: 0, f: 0 }; list.forEach(function (e) { t.k += +e.k || 0; t.p += +e.p || 0; t.c += +e.c || 0; t.f += +e.f || 0; }); return t; }

  // ── totals patch (page figures + logged food) ────────────────────────────────────────────────
  var LAST = null;   // {a, t, pa, pt} for the viewed day after the last patch
  function patchCard(card, x) {
    if (!card) return null;
    var out = {};
    var big = card.querySelector('.cv2-big');
    if (big) {
      var b = big.querySelector('b'), sp = big.querySelector('span');
      if (b && sp) {
        if (!big.hasAttribute('data-lif-t')) {
          var txt = sp.textContent || '', m = /([\d,.]+)\s+of\s+([\d,.]+)/.exec(txt);
          big.setAttribute('data-lif-a', m ? unInt(m[1]) : 0);
          big.setAttribute('data-lif-t', m ? unInt(m[2]) : unInt(b.textContent));
          big.setAttribute('data-lif-h', big.outerHTML.length);   // not used for logic; marks a page-fresh node
          big.setAttribute('data-lif-b', b.textContent); big.setAttribute('data-lif-s', txt); big.setAttribute('data-lif-o', big.classList.contains('over') ? '1' : '');
        }
        var a0 = +big.getAttribute('data-lif-a'), t = +big.getAttribute('data-lif-t'), sig = String(x.k);
        if (big.getAttribute('data-lif-sig') !== sig) {
          big.setAttribute('data-lif-sig', sig);
          if (x.n && t > 0) {
            var a = a0 + x.k, left = t - a;
            b.textContent = int(Math.abs(left));
            sp.textContent = (left >= 0 ? 'kcal left · ' : 'kcal over · ') + int(a) + ' of ' + int(t) + ' logged';
            big.classList.toggle('over', left < 0);
          } else {
            b.textContent = big.getAttribute('data-lif-b'); sp.textContent = big.getAttribute('data-lif-s');
            big.classList.toggle('over', !!big.getAttribute('data-lif-o'));
          }
        }
        out.a = a0 + (x.n ? x.k : 0); out.t = t;
      }
    }
    Array.prototype.forEach.call(card.querySelectorAll('.cv2-mtile'), function (tile) {
      var bar = tile.querySelector('i[role="progressbar"]'), b = tile.querySelector('b'), lab = tile.querySelector('span');
      if (!bar || !b || !lab || !b.firstChild) return;
      var key = /protein/i.test(lab.textContent) ? 'p' : /carb/i.test(lab.textContent) ? 'c' : /fat/i.test(lab.textContent) ? 'f' : null;
      if (!key) return;
      if (!tile.hasAttribute('data-lif-a')) {
        tile.setAttribute('data-lif-a', bar.getAttribute('aria-valuenow') || '0');
        tile.setAttribute('data-lif-b', b.firstChild.nodeValue || '');
      }
      var a0 = +tile.getAttribute('data-lif-a'), t = +bar.getAttribute('aria-valuemax') || 0, sig = String(x[key]) + '|' + x.n;
      if (key === 'p') { out.pa = a0 + (x.n ? x.p : 0); out.pt = t; }
      if (tile.getAttribute('data-lif-sig') === sig) return;
      tile.setAttribute('data-lif-sig', sig);
      var a = a0 + (x.n ? x[key] : 0), u = bar.querySelector('u');
      b.firstChild.nodeValue = x.n ? int(a) : tile.getAttribute('data-lif-b');
      bar.setAttribute('aria-valuenow', Math.round(a));
      if (u && t > 0) u.style.width = Math.min(100, Math.round(a / t * 100)) + '%';
    });
    return out;
  }
  function patchNutrition() {
    var box = document.getElementById('cv2-nutri'); if (!box) return;
    var day = viewedDay(), list = day ? logFor(day) : [], x = sumOf(list); x.n = list.length;
    var card = box.querySelector('.cv2-card');
    var r = patchCard(card && card.querySelector('.cv2-mtiles') ? card : null, x);
    if (r && day === today()) LAST = r;
    renderBox(box, card, day, list);
  }
  function patchHome() {
    var home = document.getElementById('cv2-cv2home-page'); if (!home) return;
    var tiles = home.querySelector('.cv2-mtiles.two'); if (!tiles) return;
    var list = logFor(today()), x = sumOf(list); x.n = list.length;
    var r = patchCard(tiles.closest('.cv2-card'), x); if (r) LAST = r;
  }
  function patchAll() { try { patchNutrition(); } catch (e) {} try { patchHome(); } catch (e) {} }

  function renderBox(box, card, day, list) {
    var sig = (day || '') + '|' + list.map(function (e) { return e.id + (e.s ? 1 : 0); }).join(',');
    var old = document.getElementById('lif-box');
    if (old && old.getAttribute('data-sig') === sig && box.contains(old)) return;
    if (old) old.remove();
    var kids = [el('button', { type: 'button', class: 'lif-add', id: 'lif-add', on: { click: function () { openSheet(); } } }, [
      el('span', { class: 'ic', text: '+' }),
      el('span', {}, [el('b', { text: 'Log food' }), el('small', { text: 'Search, scan a barcode or add from a label' })]),
    ])];
    if (list.length) {
      var x = sumOf(list);
      kids.push(el('div', { class: 'lif-list' }, [el('h4', {}, [el('span', { text: 'Other food' }), el('span', { text: int(x.k) + ' kcal · P ' + int(x.p) + ' g' })])].concat(list.map(function (e) {
        return el('div', { class: 'lif-row' }, [
          el('span', { class: 'tx' }, [el('b', { text: e.n }), el('small', {}, [e.a + ' · P ' + int(e.p) + ' g', e.s ? null : el('span', { class: 'lif-warnchip', title: 'Saved on this phone. It sends when you\'re connected.', text: 'Not synced yet' })])]),
          el('span', { class: 'kc', text: int(e.k) }, [el('small', { text: ' kcal' })]),
          el('button', { type: 'button', class: 'lif-rm', 'aria-label': 'Remove ' + e.n, text: '×', on: { click: function () { removeEntry(day, e.id); } } }),
        ]);
      }))));
    }
    var node = el('div', { id: 'lif-box', 'data-sig': sig }, kids);
    if (card && card.parentNode === box) box.insertBefore(node, card.nextSibling); else box.appendChild(node);
  }

  // ── log / remove / sync ──────────────────────────────────────────────────────────────────
  function addEntry(day, food, amt, unit, ui) {
    var v = calc(food, amt, unit); if (!v) return false;
    var now = new Date(), ts;
    if (day === today()) ts = now;
    else { ts = new Date(day + 'T12:00:00'); ts.setMinutes(now.getMinutes(), now.getSeconds(), now.getMilliseconds()); }
    var all = logAll();
    (all[day] = all[day] || []).push({ id: 'f' + now.getTime().toString(36) + Math.floor(Math.random() * 1e4).toString(36), ts: ts.toISOString(), n: String(food.n).slice(0, 90), a: v.label, k: v.k, p: v.p, c: v.c, f: v.f, s: false });
    if (!logSave(all)) { toast('Couldn\'t save on this phone. Storage is full.'); return false; }
    pushRecent(food, amt, ui);
    patchAll(); sync();
    return v;
  }
  // A removed food that already reached the coach (or is on its way there) is taken back on the server too.
  // The removal waits in its own queue until the server confirms it.
  function removeEntry(day, id) {
    var all = logAll(), gone = (all[day] || []).filter(function (e) { return e.id === id; })[0];
    all[day] = (all[day] || []).filter(function (e) { return e.id !== id; });
    logSave(all);
    if (gone && (gone.s || inflight[gone.id])) {
      var q = lsGet('del', []) || [];
      q.push({ id: gone.id, n: gone.n, ts: gone.ts });
      lsPut('del', q.slice(-100));
    }
    patchAll(); toast('Removed'); sync();
  }
  var inflight = {}, delflight = {};
  function syncRemovals() {
    (lsGet('del', []) || []).forEach(function (d) {
      if (!d || !d.id || delflight[d.id] || inflight[d.id]) return;      // never ahead of its own save
      delflight[d.id] = 1;
      Promise.resolve(window.cloudWrite('mealRemove', { mealName: 'Extra: ' + d.n, timestamp: d.ts }))
        .then(function (r) {
          delete delflight[d.id];
          if (!r || !r.ok) return;
          lsPut('del', (lsGet('del', []) || []).filter(function (x) { return x.id !== d.id; }));
        }, function () { delete delflight[d.id]; });
    });
  }
  function sync() {
    try {
      if (typeof window.cloudWrite !== 'function') return;
      syncRemovals();
      var all = logAll();
      Object.keys(all).forEach(function (day) { all[day].forEach(function (e) {
        if (e.s || inflight[e.id]) return;
        inflight[e.id] = 1;
        Promise.resolve(window.cloudWrite('meal', { mealName: 'Extra: ' + e.n, swapDesc: e.a, calActual: e.k, pActual: e.p, cActual: e.c, fActual: e.f, timestamp: e.ts, status: 'ate', mealIdx: -1 }))
          .then(function (r) {
            delete inflight[e.id];
            if (!r || !r.ok) { syncRemovals(); return; }
            var cur = logAll(), hit = false;
            (cur[day] || []).forEach(function (x) { if (x.id === e.id) { x.s = true; hit = true; } });
            if (hit) { logSave(cur); patchAll(); }
            syncRemovals();                                              // removed while it was being saved
          }, function () { delete inflight[e.id]; syncRemovals(); });
      }); });
    } catch (e) {}
  }

  // ── sheet ────────────────────────────────────────────────────────────────────────────────
  var S = null, stream = null, scanTimer = null;
  function stopCam() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
  }
  function closeSheet() { stopCam(); var b = document.getElementById('lif-bd'); if (b) b.remove(); document.removeEventListener('keydown', escKey); S = null; }
  function escKey(e) { if (e.key === 'Escape') closeSheet(); }
  function openSheet() {
    try {
      var day = viewedDay();
      if (!day) { toast('Go back to this week to log food.'); return; }
      if (day > today()) { toast('You can log food once that day comes.'); return; }
      closeSheet();
      S = { day: day, view: 'home', q: '', food: null };
      var sh = el('div', { class: 'lif-sh', id: 'lif-sh', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Log food' });
      var bd = el('div', { class: 'lif-bd', id: 'lif-bd', on: { click: function (e) { if (e.target === bd) closeSheet(); } } }, [sh]);
      document.body.appendChild(bd);
      document.addEventListener('keydown', escKey);
      draw();
      loadData().then(function () { if (S && S.view === 'home') drawResults(); }, function () { if (S) { S.err = true; if (S.view === 'home') drawResults(); } });
      loadChains().then(function () { if (S && S.view === 'home' && S.q) drawResults(); });
    } catch (e) {}
  }
  function head(sh, title, sub, back) {
    sh.textContent = '';
    sh.appendChild(el('button', { type: 'button', class: 'lif-x', 'aria-label': 'Close', text: '×', on: { click: closeSheet } }));
    if (back) sh.appendChild(el('button', { type: 'button', class: 'lif-back', text: '‹ Back', on: { click: function () { stopCam(); S.view = 'home'; draw(); } } }));
    sh.appendChild(el('h3', { text: title }));
    sh.appendChild(el('p', { class: 'sub', text: sub }));
  }
  function draw() {
    var sh = document.getElementById('lif-sh'); if (!sh || !S) return;
    if (S.view === 'detail') return drawDetail(sh);
    if (S.view === 'scan') return drawScan(sh);
    if (S.view === 'label') return drawLabel(sh);
    head(sh, 'Log food', 'Adds to ' + dayLabel(S.day) + ', on top of your plan meals.' + leftLine());
    var inp = el('input', { class: 'lif-in', id: 'lif-q', type: 'search', placeholder: 'Search food, e.g. banana, chicken breast', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Search food' });
    inp.value = S.q;
    var t = null;
    inp.addEventListener('input', function () { S.q = inp.value; clearTimeout(t); t = setTimeout(drawResults, 120); });
    sh.appendChild(el('div', { class: 'lif-search' }, [inp]));
    sh.appendChild(el('div', { class: 'lif-two' }, [
      el('button', { type: 'button', class: 'lif-btn ghost', id: 'lif-scan', text: '▥ Scan barcode', on: { click: function () { S.view = 'scan'; draw(); } } }),
      el('button', { type: 'button', class: 'lif-btn ghost', id: 'lif-new', text: '✎ Type a label', on: { click: function () { S.view = 'label'; S.form = { code: '' }; draw(); } } }),
    ]));
    sh.appendChild(el('div', { id: 'lif-res' }));
    drawResults();
  }
  function leftLine() {
    if (!LAST || !(LAST.t > 0) || !S || S.day !== today()) return '';
    var left = LAST.t - LAST.a;
    return ' ' + (left >= 0 ? int(left) + ' kcal left today.' : int(-left) + ' kcal over today.');
  }
  function optRow(f, sub, onPick) {
    return el('button', { type: 'button', class: 'lif-opt', on: { click: onPick } }, [
      el('span', { class: 'tx' }, [el('b', {}, [f.n, (f.fl & 1) ? el('span', { class: 'lif-warnchip', text: 'Pork' }) : null]), el('small', { text: sub })]),
      el('span', { class: 'k' }, [int(f.k), el('small', { text: f.b === 'u' ? ' kcal' : ' /100' + (f.b === 'm' ? 'ml' : 'g') })]),
    ]);
  }
  function pick(f, amt, ui) { S.view = 'detail'; S.food = f; S.amt = amt; S.ui = ui; draw(); }
  function drawResults() {
    var box = document.getElementById('lif-res'); if (!box || !S) return;
    box.textContent = '';
    var q = (S.q || '').trim();
    if (q.length >= 2) {
      if (!INDEX && !S.err) { box.appendChild(el('p', { class: 'lif-empty', text: 'Loading foods…' })); return; }
      var res = search(q, 40);
      if (!res.length) {
        box.appendChild(el('p', { class: 'lif-empty', text: S.err ? 'Couldn\'t load the food list. Check your connection, or type the numbers from the label.' : 'Nothing found for "' + q + '". Try fewer words, scan the barcode, or type the numbers from the label.' }));
        return;
      }
      res.forEach(function (f) { box.appendChild(optRow(f, SRC_LABEL[f.src] + ' · P ' + r1(f.p) + ' g', function () { pick(f); })); });
      if (DATA && DATA.credit) box.appendChild(el('p', { class: 'lif-note', text: DATA.credit }));
      return;
    }
    var rec = recents(), my = myFoods();
    if (rec.length) {
      box.appendChild(el('p', { class: 'lif-lab', text: 'Recent' }));
      rec.slice(0, 8).forEach(function (r) { box.appendChild(optRow(r.f, SRC_LABEL[r.f.src] || '', function () { pick(r.f, r.a, r.u); })); });
    }
    if (my.length) {
      box.appendChild(el('p', { class: 'lif-lab', text: 'My foods' }));
      my.slice(0, 30).forEach(function (f) { f.src = 'my'; box.appendChild(optRow(f, 'P ' + r1(f.p) + ' g', function () { pick(f); })); });
    }
    if (!rec.length && !my.length) box.appendChild(el('p', { class: 'lif-empty', text: 'Search for a food, scan its barcode, or type the numbers from the label. What you log shows up here next time.' }));
  }

  function drawDetail(sh) {
    var f = S.food, units = unitsOf(f);
    var ui = (S.ui != null && units[S.ui]) ? S.ui : (f.b === 'g' && units.length > 1 ? 1 : 0);
    var amt = S.amt != null ? S.amt : (units[ui][1] === 1 ? 100 : 1);
    head(sh, f.n, (SRC_LABEL[f.src] || '') + ' · ' + perLine(f), true);
    if (f.fl & 1) sh.appendChild(el('p', { class: 'lif-flag', text: 'This usually has pork in it. Check before you eat it.' }));
    var inp = el('input', { class: 'lif-in', id: 'lif-amt', type: 'text', inputmode: 'decimal', 'aria-label': 'Amount' });
    inp.value = String(amt);
    var unitTxt = el('span', { id: 'lif-unit' });
    var tot = el('div', { class: 'lif-tot', id: 'lif-tot' });
    var addBtn = el('button', { type: 'button', class: 'lif-btn wide', id: 'lif-go', text: 'Add to ' + dayLabel(S.day) });
    var step = function () { return units[ui][1] === 1 ? (f.b === 'm' ? 50 : 10) : 0.5; };
    var upd = function () {
      S.amt = inp.value; S.ui = ui;
      unitTxt.textContent = units[ui][1] === 1 ? units[ui][0] : '× ' + units[ui][0];
      var v = calc(f, inp.value, units[ui]);
      tot.textContent = '';
      [['kcal', v ? int(v.k) : '–'], ['Protein', v ? r1(v.p) + ' g' : '–'], ['Carbs', v ? r1(v.c) + ' g' : '–'], ['Fat', v ? r1(v.f) + ' g' : '–']]
        .forEach(function (x) { tot.appendChild(el('div', {}, [el('b', { text: x[1] }), el('span', { text: x[0] })])); });
      addBtn.disabled = !v;
    };
    inp.addEventListener('input', upd);
    var bump = function (dir) { var a = num(inp.value) || 0, s = step(), n = Math.max(s, Math.round((a + dir * s) / s) * s); inp.value = String(r1(n)); upd(); };
    sh.appendChild(el('div', { class: 'lif-amt' }, [
      el('button', { type: 'button', class: 'lif-step', 'aria-label': 'Less', text: '−', on: { click: function () { bump(-1); } } }),
      inp,
      el('button', { type: 'button', class: 'lif-step', 'aria-label': 'More', text: '+', on: { click: function () { bump(1); } } }),
      unitTxt,
    ]));
    if (units.length > 1) {
      var chips = el('div', { class: 'lif-chips', role: 'group', 'aria-label': 'Unit' });
      units.forEach(function (u, i) {
        chips.appendChild(el('button', { type: 'button', class: 'lif-chip' + (i === ui ? ' on' : ''), text: u[1] === 1 ? (f.b === 'm' ? 'millilitres' : 'grams') : u[0] + ' · ' + Math.round(u[1]) + (f.b === 'm' ? ' ml' : ' g'), on: { click: function () {
          var was = units[ui][1], a = num(inp.value) || 0;
          ui = i;
          if (was !== 1 && u[1] === 1) inp.value = String(Math.round(a * was));        // 2 medium bananas -> 255 g
          else if (was === 1 && u[1] !== 1) inp.value = '1';
          Array.prototype.forEach.call(chips.children, function (c, j) { c.classList.toggle('on', j === i); });
          upd();
        } } }));
      });
      sh.appendChild(chips);
    }
    sh.appendChild(tot);
    addBtn.addEventListener('click', function () {
      var v = addEntry(S.day, f, inp.value, units[ui], ui);
      if (!v) return;
      var d = S.day; closeSheet();
      toast('Added to ' + dayLabel(d) + ' · ' + int(v.k) + ' kcal');
    });
    sh.appendChild(addBtn);
    if (f.src === 'off') {
      sh.appendChild(el('p', { class: 'lif-note', text: 'From Open Food Facts, a public product list. Check it against the label on the pack.' }));
      sh.appendChild(el('button', { type: 'button', class: 'lif-back', text: 'Numbers don\'t match the label? Fix them', on: { click: function () { S.view = 'label'; S.form = { code: f.code || '', name: f.n, per: 'g', k: f.k, p: f.p, c: f.c, f: f.f, kcal: true }; draw(); } } }));
    } else if (f.src === 'db') {
      sh.appendChild(el('p', { class: 'lif-note', text: 'Average figures for this food in Australia. A packet with a label is more exact: scan it or type the label.' }));
    }
    upd();
  }

  // ── label form ───────────────────────────────────────────────────────────────────────────
  function drawLabel(sh) {
    var F = S.form || (S.form = {});
    head(sh, 'Type a label', 'Copy the numbers from the nutrition panel on the pack. It saves to My foods.', true);
    var form = el('div', { class: 'lif-form' });
    var field = function (id, label, val, attrs) {
      var i = el('input', Object.assign({ class: 'lif-in', id: id, type: 'text', autocomplete: 'off' }, attrs || {})); if (val != null) i.value = String(val);
      return [el('label', { for: id, text: label }), i];
    };
    var per = F.per || 'g', kcal = !!F.kcal;
    var add = function (nodes, into) { nodes.forEach(function (n) { (into || form).appendChild(n); }); };
    add(field('lif-f-name', 'Name', F.name || '', { placeholder: 'e.g. Chobani Fit vanilla' }));
    var perChips = el('div', { class: 'lif-chips' }), enChips = el('div', { class: 'lif-chips' });
    var chip = function (box, label, on, fn) { var c = el('button', { type: 'button', class: 'lif-chip' + (on ? ' on' : ''), text: label, on: { click: fn } }); box.appendChild(c); return c; };
    var keep = function () { ['name', 'e', 'p', 'c', 'f', 'serve'].forEach(function (k) { var n = document.getElementById('lif-f-' + k); if (n) F['_' + k] = n.value; }); };
    chip(perChips, 'Numbers are per 100 g', per === 'g', function () { keep(); F.per = 'g'; drawLabel(sh); });
    chip(perChips, 'Per serve', per === 'u', function () { keep(); F.per = 'u'; drawLabel(sh); });
    form.appendChild(el('label', { text: 'Which column are you copying?' })); form.appendChild(perChips);
    chip(enChips, 'Energy in kJ', !kcal, function () { keep(); F.kcal = false; drawLabel(sh); });
    chip(enChips, 'Energy in Cal (kcal)', kcal, function () { keep(); F.kcal = true; drawLabel(sh); });
    form.appendChild(el('label', { text: 'Energy unit on the label' })); form.appendChild(enChips);
    var g = el('div', { class: 'lif-grid' });
    var cell = function (nodes) { var d = el('div'); add(nodes, d); g.appendChild(d); };
    cell(field('lif-f-e', kcal ? 'Energy (Cal)' : 'Energy (kJ)', F._e != null ? F._e : (F.k != null && kcal ? F.k : ''), { inputmode: 'decimal' }));
    cell(field('lif-f-p', 'Protein (g)', F._p != null ? F._p : (F.p != null ? F.p : ''), { inputmode: 'decimal' }));
    cell(field('lif-f-c', 'Carbohydrate (g)', F._c != null ? F._c : (F.c != null ? F.c : ''), { inputmode: 'decimal' }));
    cell(field('lif-f-f', 'Fat, total (g)', F._f != null ? F._f : (F.f != null ? F.f : ''), { inputmode: 'decimal' }));
    form.appendChild(g);
    add(field('lif-f-serve', per === 'u' ? 'Serve size (optional), e.g. 1 tub 160 g' : 'Serve size in grams (optional)', F._serve || '', per === 'u' ? {} : { inputmode: 'decimal' }));
    if (F._name != null) form.querySelector('#lif-f-name').value = F._name;
    var msg = el('p', { class: 'lif-note', id: 'lif-f-msg', role: 'alert' });
    var save = el('button', { type: 'button', class: 'lif-btn wide', id: 'lif-f-save', text: 'Save and use', on: { click: function () {
      keep();
      var name = String(F._name || '').trim(), e = num(F._e), p = num(F._p), c = num(F._c), f = num(F._f);
      if (name.length < 2) { msg.textContent = 'Give it a name so you can find it next time.'; return; }
      if (e == null || e < 0 || p == null || c == null || f == null || p < 0 || c < 0 || f < 0) { msg.textContent = 'Fill in energy, protein, carbohydrate and fat. Use 0 if the label says 0.'; return; }
      var k = F.kcal ? e : e / KJ;
      var est = p * 4 + c * 4 + f * 9;
      if (per === 'g' && (k > 905 || p + c + f > 101)) { msg.textContent = 'Those numbers are too high for 100 g. Check which column you copied.'; return; }
      if (k > 0 && est > 0 && (est > k * 1.6 + 20 || est < k * 0.5 - 20) && !F._sure) { F._sure = true; msg.textContent = 'Energy doesn\'t match the protein, carbs and fat (they add up to about ' + int(est) + ' Cal). Check kJ vs Cal, then tap Save again if the label really says this.'; return; }
      var food = { n: name.slice(0, 80), b: per, k: Math.round(k), p: r1(p), c: r1(c), f: r1(f), fl: PORK.test(name) ? 1 : 0, ms: [], u: '', code: F.code || '' };
      if (per === 'u') food.u = String(F._serve || '').trim().slice(0, 30) || 'serve';
      else { var sg = num(F._serve); if (sg > 0 && sg < 2000) food.ms = [['1 serve', r1(sg)]]; }
      var saved = saveMy(food);
      S.form = null; pick(saved);
    } } });
    sh.appendChild(form); sh.appendChild(msg); sh.appendChild(save);
    if (F.code) sh.appendChild(el('p', { class: 'lif-note', text: 'Barcode ' + F.code + ' is saved with it, so next time a scan finds it straight away.' }));
  }

  // ── barcode ──────────────────────────────────────────────────────────────────────────────
  var zxP = null;
  function loadZX() {
    if (zxP) return zxP;
    zxP = (window.ZXingWASM ? Promise.resolve() : loadScript(BASE + 'vendor/zxing/reader.js')).then(function () {
      var wasm = new URL(BASE + 'vendor/zxing/zxing_reader.wasm', location.href).href;
      return window.ZXingWASM.prepareZXingModule({ overrides: { locateFile: function (p) { return /\.wasm$/.test(p) ? wasm : p; } }, fireImmediately: true });
    }).catch(function (e) { zxP = null; throw e; });
    return zxP;
  }
  function validCode(c) { return /^\d{8}$|^\d{12,14}$/.test(c); }
  function decode(source) {   // source: ImageData | Blob
    return loadZX().then(function () { return window.ZXingWASM.readBarcodes(source, { formats: ['EANUPC'], tryHarder: true, maxNumberOfSymbols: 1 }); })
      .then(function (r) { var t = r && r[0] && String(r[0].text || '').replace(/\D/g, ''); return validCode(t) ? t : null; });
  }
  /* The strip of the camera picture the scanner reads: the middle band, where the frame is drawn. Small = fast. */
  function band(vw, vh) {
    var sw = Math.round(vw * 0.9), sh = Math.round(vh * 0.46);
    var k = Math.min(1, 1000 / sw);
    return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw: sw, sh: sh, w: Math.round(sw * k), h: Math.round(sh * k) };
  }
  function drawScan(sh) {
    head(sh, 'Scan barcode', 'Line the barcode up inside the frame. Hold it steady, about a hand away.', true);
    var video = el('video', { playsinline: '', muted: '', autoplay: '' }); video.muted = true;
    var msg = el('div', { class: 'msg', text: 'Starting the camera…' });
    var cam = el('div', { class: 'lif-cam' }, [video, msg]);
    sh.appendChild(cam);
    var typed = el('input', { class: 'lif-in', id: 'lif-code', type: 'text', inputmode: 'numeric', placeholder: 'Or type the barcode number', 'aria-label': 'Barcode number' });
    var file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'lif-file', style: 'display:none' });
    var status = el('p', { class: 'lif-note', id: 'lif-scan-msg', role: 'status' });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      status.textContent = 'Reading the photo…';
      decode(f).then(function (code) { if (code) found(code); else status.textContent = 'Couldn\'t read a barcode in that photo. Try again closer, or type the number under the bars.'; },
        function () { status.textContent = 'The scanner didn\'t load. Type the number under the bars instead.'; });
    });
    sh.appendChild(el('div', { class: 'lif-search' }, [typed, el('button', { type: 'button', class: 'lif-btn', id: 'lif-code-go', text: 'Look up', on: { click: function () {
      var c = typed.value.replace(/\D/g, ''); if (!validCode(c)) { status.textContent = 'A barcode has 8, 12 or 13 digits.'; return; } found(c);
    } } })]));
    sh.appendChild(el('button', { type: 'button', class: 'lif-btn ghost', text: 'Take a photo of the barcode instead', on: { click: function () { file.click(); } } }));
    sh.appendChild(file); sh.appendChild(status);

    var done = false;
    function found(code, live) {
      if (done) return; done = true;
      if (!live) { stopCam(); return lookup(code); }
      // got it: freeze the picture, green frame, buzz where the phone allows it, then look it up
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      try { video.pause(); } catch (e) {}
      cam.classList.add('hit'); cam.appendChild(el('div', { class: 'ok', text: '✓ Got it' }));
      try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
      setTimeout(function () { stopCam(); if (S && S.view === 'scan') lookup(code); }, 380);
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = 'The camera isn\'t available here. Take a photo or type the number.'; return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }).then(function (st) {
      if (!S || S.view !== 'scan' || done) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = st; video.srcObject = st; msg.remove();
      var p = video.play(); if (p && p.catch) p.catch(function () {});
      var det = null;
      try { if ('BarcodeDetector' in window) det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); } catch (e) { det = null; }
      if (!det) loadZX().catch(function () { status.textContent = 'The scanner didn\'t load. Type the number under the bars instead.'; });
      // torch, on phones whose camera lets a web page switch it
      try {
        var track = st.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : null;
        if (caps && caps.torch) {
          var lit = false, tb = el('button', { type: 'button', class: 'lif-torch', id: 'lif-torch', 'aria-pressed': 'false', text: 'Torch', on: { click: function () {
            lit = !lit;
            track.applyConstraints({ advanced: [{ torch: lit }] }).then(function () { tb.classList.toggle('on', lit); tb.setAttribute('aria-pressed', String(lit)); }, function () { lit = false; tb.remove(); });
          } } });
          cam.appendChild(tb);
        }
        if (caps && caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      } catch (e) {}
      var canvas = document.createElement('canvas'), busy = false, n = 0, t0 = Date.now(), hinted = false;
      (function tick() {
        if (done || !stream) return;
        scanTimer = setTimeout(tick, det ? 150 : 120);
        if (!hinted && Date.now() - t0 > 8000) { hinted = true; status.textContent = 'Not picking it up? Move closer, tilt away from glare, or type the number under the bars.'; }
        if (busy || video.readyState < 2 || !video.videoWidth) return;
        busy = true;
        var job;
        if (det) job = det.detect(video).then(function (r) { var t = r && r[0] && String(r[0].rawValue || ''); return validCode(t) ? t : null; });
        else {
          // the middle band most of the time (fast); every 6th look, the whole picture (a barcode held sideways or off-centre)
          var vw = video.videoWidth, vh = video.videoHeight, b = band(vw, vh);
          if (++n % 6 === 0) { var k = Math.min(1, 960 / vw); b = { sx: 0, sy: 0, sw: vw, sh: vh, w: Math.round(vw * k), h: Math.round(vh * k) }; }
          canvas.width = b.w; canvas.height = b.h;
          var cx = canvas.getContext('2d', { willReadFrequently: true }); cx.drawImage(video, b.sx, b.sy, b.sw, b.sh, 0, 0, b.w, b.h);
          job = decode(cx.getImageData(0, 0, b.w, b.h));
        }
        job.then(function (code) { busy = false; if (code) found(code, true); }, function () { busy = false; });
      })();
    }, function () { msg.textContent = 'Camera is blocked. Allow it in your phone settings, or take a photo or type the number.'; });
  }
  function fromOFF(code, j) {
    var p = j && j.product, n = p && p.nutriments; if (!p || !n) return null;
    var k = num(n['energy-kcal_100g']); if (k == null && num(n['energy-kj_100g']) != null) k = num(n['energy-kj_100g']) / KJ; if (k == null && num(n.energy_100g) != null) k = num(n.energy_100g) / KJ;
    var pr = num(n.proteins_100g), c = num(n.carbohydrates_100g), f = num(n.fat_100g);
    if (k == null || pr == null || c == null || f == null || k < 0 || k > 905 || pr + c + f > 101) return null;
    var name = [String(p.brands || '').split(',')[0].trim(), String(p.product_name || '').trim()].filter(Boolean).join(' ').slice(0, 80);
    if (name.length < 2) return null;
    var food = { n: name, b: 'g', k: Math.round(k), p: r1(pr), c: r1(c), f: r1(f), fl: PORK.test(name + ' ' + (p.ingredients_text || '')) ? 1 : 0, ms: [], u: '', src: 'off', code: code };
    var sq = num(p.serving_quantity); if (sq > 0 && sq < 2000) food.ms = [['1 serve', r1(sq)]];
    return food;
  }
  function lookup(code) {
    var mine = myFoods().filter(function (f) { return f.code === code; })[0];
    if (mine) { mine.src = 'my'; return pick(mine); }
    var sh = document.getElementById('lif-sh'); if (!sh || !S) return;
    S.view = 'wait'; head(sh, 'Looking it up…', 'Barcode ' + code, true);
    var miss = function (why) {
      if (!S) return;
      S.view = 'label'; S.form = { code: code }; draw();
      var m = document.getElementById('lif-f-msg'); if (m) m.textContent = why;
    };
    var ctl = null, timer = null;
    try { ctl = new AbortController(); timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 9000); } catch (e) {}
    fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=product_name,brands,nutriments,serving_quantity,ingredients_text',
      { signal: ctl ? ctl.signal : undefined, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        if (!S || S.view !== 'wait') return;
        var food = fromOFF(code, j);
        if (food) pick(food); else miss('That product isn\'t in the list yet. Type the numbers from the pack once and it\'s saved for next time.');
      }, function () { if (timer) clearTimeout(timer); if (S && S.view === 'wait') miss('Couldn\'t look that barcode up right now. Type the numbers from the pack instead.'); });
  }

  // ── boot ─────────────────────────────────────────────────────────────────────────────────
  function boot(opts) {
    try {
      if (o || !opts || !opts.storageKey || OFF[opts.storageKey]) return;
      if (!document.body.classList.contains('cv2')) return;   // V2 screens only
      o = opts; BASE = String(opts.base || '../../'); css();
      var watch = function (id, fn, deep) { var n = document.getElementById(id); if (n && window.MutationObserver) new MutationObserver(fn).observe(n, { childList: true, subtree: !!deep }); };
      watch('section-nutrition', function () { try { patchNutrition(); } catch (e) {} }, true);
      watch('cv2-cv2home-page', function () { try { patchHome(); } catch (e) {} }, true);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) { patchAll(); sync(); } });
      window.addEventListener('online', sync);
      patchAll(); sync();
    } catch (e) {}
  }
  window.LockedInFood = { boot: boot, open: openSheet, _t: { search: search, calc: calc, unitsOf: unitsOf, fromOFF: fromOFF, validCode: validCode, viewedDay: viewedDay, decode: decode, band: band, loadData: loadData } };
})();
