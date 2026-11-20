/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   LOCKED IN — SWAP MEAL SHEET (2026-11-20)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   One bottom sheet for "I'm eating something else", in the V2 look. It replaces the classic centred pop-up
   (#swap-modal-overlay) on V2 pages only.

   It is a new FACE on the page's own swap engine, not a new engine:
     - the ranking is the page's sw3Rank (meals from this client's own plan, favourites, recents); pages without it
       open on Search instead
     - the verdict is the page's sw2Judge (same thresholds as before)
     - the save is the page's sw2Save -> postMealLog, exactly as the old form did it. This file fills the old (hidden)
       form and calls it, so the entry, the queue, the Saved pill and the coach side are unchanged.
   If a page lacks sw2Judge or sw2Save this file does nothing and the old pop-up keeps working.

   Four ways in, one sheet:   Suggested (one tap)  |  Search foods  |  Eating out  |  My own                            */
(function () {
  'use strict';
  var o = null, BASE = '../../', orig = null, PRE = null;
  var S = null;   // { week, day, idx, meal, t, tab, items, q, own, done }

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
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; }
  function r0(x) { return Math.round(Number(x) || 0); }
  function sign(n, unit) { var r = r0(n); return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r) + unit; }
  function ready() {
    return typeof window.sw2Save === 'function' && typeof window.sw2Judge === 'function'
      && typeof window.getMealDay === 'function' && !!document.getElementById('sw-desc') && !!window._sw2;
  }

  function css() {
    if (document.getElementById('lsw-css')) return;
    var s = document.createElement('style'); s.id = 'lsw-css';
    s.textContent = [
      '.lsw-bd{position:fixed;inset:0;background:rgba(10,12,16,.45);z-index:2147482000;display:flex;align-items:flex-end;justify-content:center}',
      '.lsw-sh{background:var(--c-bg,#faf8f4);color:var(--c-text,#16181c);width:min(100%,560px);max-height:88vh;min-height:min(62vh,520px);display:flex;flex-direction:column;border-radius:22px 22px 0 0;font-family:inherit;transform:translateY(0);animation:lsw-up .18s ease-out}',
      '@keyframes lsw-up{from{transform:translateY(24px);opacity:.6}to{transform:translateY(0);opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.lsw-sh{animation:none}}',
      '.lsw-sh.fin{min-height:0}','.lsw-hd{padding:16px 16px 0;flex:0 0 auto}.lsw-bdy{padding:12px 16px calc(20px + env(safe-area-inset-bottom));overflow:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto}',
      '.lsw-sh h3{margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em}',
      '.lsw-sub{margin:4px 0 12px;font-size:13px;color:var(--c-muted,#5d636b)}.lsw-sub b{color:var(--c-text,#16181c);font-weight:700}',
      '.lsw-x{float:right;font:inherit;font-size:24px;line-height:1;background:none;border:0;color:var(--c-muted,#5d636b);cursor:pointer;padding:0 4px;margin-top:-2px}',
      '.lsw-tabs{display:flex;gap:4px;background:var(--c-surface2,#f0ede7);border-radius:12px;padding:4px}',
      '.lsw-tab{flex:1;font:inherit;font-size:13px;font-weight:700;border:0;background:none;color:var(--c-muted,#5d636b);padding:9px 2px;border-radius:9px;cursor:pointer;white-space:nowrap}',
      '.lsw-tab.on{background:var(--c-surface,#fff);color:var(--c-text,#16181c);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
      '.lsw-opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;font:inherit;background:var(--c-surface,#fff);color:inherit;border:1px solid var(--c-line,#e9e5dd);border-radius:14px;padding:13px 14px;margin:0 0 8px;cursor:pointer}',
      '.lsw-opt:active{transform:scale(.99)}.lsw-opt[disabled]{opacity:.55}',
      '.lsw-opt .tx{flex:1;min-width:0}.lsw-opt b{display:block;font-size:15px;font-weight:700;line-height:1.25}.lsw-opt small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin-top:3px}',
      '.lsw-opt .go{flex:0 0 auto;font-size:13px;font-weight:800;color:var(--c-accent,#e8552d)}',
      '.lsw-tag{display:inline-block;font-size:11px;font-weight:800;padding:2px 7px;border-radius:999px;margin-right:6px}',
      '.lsw-tag.good{background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48)}.lsw-tag.close{background:var(--c-warn-tint,#fff4e0);color:var(--c-warn,#9a5b00)}.lsw-tag.big{background:var(--c-surface2,#f0ede7);color:var(--c-muted,#5d636b)}',
      '.lsw-lbl{font-size:12px;font-weight:700;color:var(--c-muted,#5d636b);margin:12px 0 6px}',
      '.lsw-in{width:100%;box-sizing:border-box;font:inherit;font-size:16px;background:var(--c-surface,#fff);color:inherit;border:1px solid var(--c-line,#e9e5dd);border-radius:12px;padding:12px 13px;outline:none}',
      '.lsw-in:focus{border-color:var(--c-accent,#e8552d)}',
      '.lsw-row{display:flex;gap:8px}.lsw-row>label{flex:1;min-width:0}.lsw-row .lsw-lbl{margin-top:10px}',
      '.lsw-btn{display:block;width:100%;font:inherit;font-size:16px;font-weight:800;border:0;border-radius:14px;padding:15px;margin-top:14px;background:var(--c-accent,#e8552d);color:#fff;cursor:pointer}',
      '.lsw-btn[disabled]{opacity:.5}.lsw-btn.ghost{background:none;color:var(--c-text,#16181c);border:1px solid var(--c-line,#e9e5dd);font-weight:700}',
      '.lsw-link{font:inherit;font-size:13px;font-weight:700;background:none;border:0;color:var(--c-accent,#e8552d);padding:8px 0;cursor:pointer}',
      '.lsw-v{border-radius:14px;padding:12px 14px;margin-top:12px;font-size:13px;background:var(--c-surface2,#f0ede7);color:var(--c-muted,#5d636b)}',
      '.lsw-v b{display:block;font-size:14px;color:var(--c-text,#16181c);margin-bottom:2px}',
      '.lsw-v.good{background:var(--c-ok-tint,#edf6f1)}.lsw-v.good b{color:var(--c-ok,#0f7a48)}.lsw-v.close{background:var(--c-warn-tint,#fff4e0)}.lsw-v.close b{color:var(--c-warn,#9a5b00)}',
      '.lsw-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;background:var(--c-surface,#fff);border:1px solid var(--c-line,#e9e5dd);border-radius:999px;padding:6px 10px;margin:0 6px 6px 0;color:inherit;cursor:pointer}',
      '.lsw-chip i{font-style:normal;color:var(--c-muted,#5d636b);font-size:15px;line-height:1}',
      '.lsw-empty{font-size:13.5px;color:var(--c-muted,#5d636b);padding:18px 4px;text-align:center}',
      '.lsw-done{text-align:center;padding:26px 8px 4px}.lsw-done .ok{width:56px;height:56px;border-radius:50%;background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48);display:inline-flex;align-items:center;justify-content:center;font-size:28px;font-weight:800}',
      '.lsw-done h4{margin:14px 0 4px;font-size:21px;font-weight:800;letter-spacing:-.02em}.lsw-done p{margin:2px 0;font-size:14px;color:var(--c-muted,#5d636b)}.lsw-done p.n{color:var(--c-text,#16181c);font-weight:700;font-size:15px}',
      '.lsw-amt{display:flex;gap:8px;align-items:center;margin-top:8px}.lsw-amt .lsw-in{flex:0 0 96px;width:96px;text-align:center}.lsw-amt select.lsw-in{flex:1;width:auto;text-align:left}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── open / close ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function close() { var b = document.getElementById('lsw-bd'); if (b) b.remove(); document.removeEventListener('keydown', esc); S = null; }
  function esc(e) { if (e.key === 'Escape' && !(S && S.saving)) close(); }
  function hideOld() { var ov = document.getElementById('swap-modal-overlay'); if (ov) ov.classList.remove('open'); }

  function open(week, dayIdx, mealIdx) {
    if (!ready()) return orig.apply(window, [week, dayIdx, mealIdx]);
    /* The page's own open sets the context sw2Save reads (which meal, its targets, clean form). Its pop-up is then
       hidden in the same tick, so it never paints. */
    try { orig.apply(window, [week, dayIdx, mealIdx]); } catch (e) { return; }
    hideOld();
    var preset = PRE; PRE = null;
    var meal = (window.getMealDay(week, dayIdx) || [])[mealIdx] || {};
    var t = { cal: meal.cal || 0, p: meal.p || 0, c: meal.c || 0, f: meal.f || 0, time: meal.time || '' };
    css();
    S = { week: week, day: dayIdx, idx: mealIdx, meal: meal, t: t, tab: preset ? 'own' : HAS_RANK() ? 'pick' : 'search', items: [], q: '', food: null,
      own: preset ? { name: preset.name, k: preset.k, p: preset.p, c: preset.c, f: preset.f, more: preset.c != null || preset.f != null } : { name: '', k: '', p: '', c: '', f: '', more: false },
      saving: false, done: null };
    var old = document.getElementById('lsw-bd'); if (old) old.remove();
    var sh = el('div', { class: 'lsw-sh', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Swap meal' });
    var bd = el('div', { class: 'lsw-bd', id: 'lsw-bd', on: { click: function (e) { if (e.target === bd && !(S && S.saving)) close(); } } }, [sh]);
    document.body.appendChild(bd);
    document.addEventListener('keydown', esc);
    draw();
  }

  // ── verdict (the page's engine) ────────────────────────────────────────────────────────────────────────────────────────
  function judge(k, p) { try { return window.sw2Judge(S.t, k, p); } catch (e) { return { k: 'wait' }; } }
  function tagFor(v) {
    if (v.k === 'good') return el('span', { class: 'lsw-tag good', text: 'Great match' });
    if (v.k === 'close') return el('span', { class: 'lsw-tag close', text: 'Close' });
    if (v.k === 'big') return el('span', { class: 'lsw-tag big', text: 'Bigger change' });
    return null;
  }
  function verdictBox(k, p) {
    var v = judge(k, p);
    if (v.k === 'wait') return el('div', { class: 'lsw-v' }, ['Add calories and protein to see how close it is.']);
    var head = v.k === 'good' ? 'Good swap' : v.k === 'close' ? 'Pretty close' : 'This changes the meal quite a bit';
    var sub = sign(v.dCal, ' kcal') + ' and ' + sign(v.dP, ' g protein') + ' against the planned meal.'
      + (v.k === 'big' ? ' You can still log it. Your coach sees the difference either way.' : '');
    return el('div', { class: 'lsw-v ' + v.k }, [el('b', { text: head }), sub]);
  }

  // ── save (the page's sw2Save, through its own form) ────────────────────────────────────────────────────────────────────
  function save(entry) {
    if (!S || S.saving) return;
    var name = String(entry.name || '').trim(); if (!name) return;
    S.saving = true; draw();
    var put = function (id, v) { var n = document.getElementById(id); if (n) n.value = v == null || v === '' ? '' : String(v); };
    try { window._sw2.touched = true; } catch (e) {}
    put('sw-desc', name); put('sw-cal', entry.k); put('sw-p', entry.p); put('sw-c', entry.c); put('sw-f', entry.f);
    var fin = function () {
      if (!S) return;
      var txt = function (sel) { var n = document.querySelector(sel); return n ? n.textContent.trim() : ''; };
      var last = (window._sw2 && window._sw2.last) || null;
      S.saving = false;
      if (!last || last.name !== name) { S.err = 'That didn\'t save. Try again.'; draw(); return; }
      S.done = { head: txt('#swapv2-done .sw2-done-head') || 'Meal swapped', name: name, macros: last.cal + ' kcal · ' + last.p + ' g protein', verdict: txt('#sw2-done-verdict'), fav: false };
      hideOld(); draw();
    };
    var p; try { p = window.sw2Save(); } catch (e) { p = null; }
    Promise.resolve(p).then(fin, fin);
  }

  // ── draw ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function HAS_RANK() { return typeof window.sw3Rank === 'function'; }
  var TABS = [['pick', 'Suggested'], ['search', 'Search'], ['out', 'Eating out'], ['own', 'My own']];
  function draw() {
    var sh = document.querySelector('#lsw-bd .lsw-sh'); if (!sh || !S) return;
    var keep = (sh.querySelector('.lsw-bdy') || {}).scrollTop || 0;
    sh.textContent = '';
    sh.classList.toggle('fin', !!S.done);
    if (S.done) return drawDone(sh);
    var hd = el('div', { class: 'lsw-hd' }, [
      el('button', { type: 'button', class: 'lsw-x', 'aria-label': 'Close', text: '×', on: { click: function () { if (!S.saving) close(); } } }),
      el('h3', { text: 'Swap meal' }),
      el('p', { class: 'lsw-sub' }, ['Instead of ', el('b', { text: S.meal.name || 'this meal' }), ' · ' + S.t.cal + ' kcal · ' + S.t.p + ' g protein']),
      el('div', { class: 'lsw-tabs', role: 'tablist' }, TABS.filter(function (t) { return (t[0] !== 'pick' || HAS_RANK()) && (t[0] !== 'out' || (window.LockedInPlus && document.getElementById('lip-eo'))); }).map(function (t) {
        return el('button', { type: 'button', role: 'tab', class: 'lsw-tab' + (S.tab === t[0] ? ' on' : ''), 'data-tab': t[0], text: t[1], on: { click: function () {
          if (S.saving) return;
          if (t[0] === 'out') return eatOut();
          S.tab = t[0]; S.err = null; draw();
        } } });
      })),
    ]);
    var body = el('div', { class: 'lsw-bdy' });
    sh.appendChild(hd); sh.appendChild(body);
    if (S.err) body.appendChild(el('div', { class: 'lsw-v close' }, [el('b', { text: S.err })]));
    if (S.tab === 'pick') drawPick(body); else if (S.tab === 'search') drawSearch(body); else drawOwn(body);
    body.scrollTop = keep;
  }

  function drawPick(body) {
    var picks = []; try { picks = window.sw3Rank(S.t, S.meal.name, 5) || []; } catch (e) {}
    if (!picks.length) {
      body.appendChild(el('div', { class: 'lsw-empty' }, ['Nothing in your plan is close enough to this meal. Search a food or add your own.']));
      body.appendChild(el('button', { type: 'button', class: 'lsw-btn ghost', text: 'Search foods', on: { click: function () { S.tab = 'search'; draw(); } } }));
      return;
    }
    body.appendChild(el('div', { class: 'lsw-lbl', text: 'Closest to this meal, from your plan. Tap one to swap.' }));
    picks.forEach(function (x) {
      var v = judge(x.cal, x.p);
      var src = x.src === 'fav' ? ' · Favourite' : x.src === 'recent' ? ' · Had before' : '';
      body.appendChild(el('button', { type: 'button', class: 'lsw-opt lsw-pick', disabled: S.saving ? '' : null, on: { click: function () { save({ name: x.name, k: x.cal, p: x.p, c: x.c, f: x.f }); } } }, [
        el('span', { class: 'tx' }, [
          el('b', { text: x.name }),
          el('small', {}, [tagFor(v), x.cal + ' kcal · ' + x.p + ' g protein' + src]),
        ]),
        el('span', { class: 'go', text: S.saving ? '…' : 'Swap' }),
      ]));
    });
  }

  // Search: build the meal from one or more foods (the Log food database), totals judged live.
  function F() { return (window.LockedInFood && window.LockedInFood._t) || null; }
  function totals() { var t = { k: 0, p: 0, c: 0, f: 0 }; S.items.forEach(function (i) { t.k += i.k; t.p += i.p; t.c += i.c; t.f += i.f; }); return { k: r0(t.k), p: r0(t.p), c: r0(t.c), f: r0(t.f) }; }
  function drawSearch(body) {
    var f = F();
    if (!f || !f.loadData) { body.appendChild(el('div', { class: 'lsw-empty', text: 'Food search isn\'t available on this page. Use My own.' })); return; }
    if (S.food) return drawAmount(body, f);
    if (S.items.length) {
      var box = el('div', {});
      S.items.forEach(function (it, i) {
        box.appendChild(el('button', { type: 'button', class: 'lsw-chip', 'aria-label': 'Remove ' + it.label, on: { click: function () { S.items.splice(i, 1); draw(); } } }, [it.n + ' · ' + it.label, el('i', { text: '×' })]));
      });
      body.appendChild(box);
      var t = totals();
      body.appendChild(el('div', { class: 'lsw-sub', text: 'Total: ' + t.k + ' kcal · ' + t.p + ' g protein · ' + t.c + ' g carbs · ' + t.f + ' g fat' }));
    }
    var list = el('div', { class: 'lsw-res' });
    var inp = el('input', { class: 'lsw-in lsw-q', type: 'search', placeholder: S.items.length ? 'Add another food' : 'Search a food, e.g. chicken breast', autocomplete: 'off', value: S.q, 'aria-label': 'Search foods' });
    var fill = function () {
      list.textContent = '';
      var q = S.q.trim(); if (q.length < 2) return;
      var hits = []; try { hits = f.search(q, 12); } catch (e) {}
      if (!hits.length) { list.appendChild(el('div', { class: 'lsw-empty', text: 'No match. Try a simpler word, or use My own.' })); return; }
      hits.forEach(function (h) {
        var base = h.b === 'u' ? 'per ' + (h.u || 'serve') : h.b === 'm' ? 'per 100 ml' : 'per 100 g';
        list.appendChild(el('button', { type: 'button', class: 'lsw-opt lsw-hit', on: { click: function () {
          var us = f.unitsOf(h);
          S.food = { f: h, units: us, ui: 0, amt: h.b === 'u' ? '1' : '100' }; draw();
        } } }, [el('span', { class: 'tx' }, [el('b', { text: h.n }), el('small', { text: r0(h.k) + ' kcal · ' + r0(h.p) + ' g protein · ' + base })]), el('span', { class: 'go', text: 'Add' })]));
      });
    };
    inp.addEventListener('input', function () { S.q = inp.value; fill(); });
    body.appendChild(inp);
    body.appendChild(list);
    if (S.items.length) {
      var tt = totals();
      body.appendChild(verdictBox(tt.k, tt.p));
      body.appendChild(el('button', { type: 'button', class: 'lsw-btn lsw-log', disabled: S.saving ? '' : null, text: S.saving ? 'Saving…' : 'Log swap', on: { click: function () {
        save({ name: S.items.map(function (i) { return i.n + ' (' + i.label + ')'; }).join(' + ').slice(0, 160), k: tt.k, p: tt.p, c: tt.c, f: tt.f });
      } } }));
    }
    f.loadData().then(function () { if (S && S.tab === 'search' && !S.food) fill(); }, function () { list.textContent = ''; list.appendChild(el('div', { class: 'lsw-empty', text: 'Couldn\'t load the food list. Check your connection, or use My own.' })); });
    if (!S.items.length && !S.q) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
  }
  function drawAmount(body, f) {
    var x = S.food, h = x.f;
    var out = el('div', {});
    var amt = el('input', { class: 'lsw-in lsw-amt-in', type: 'text', inputmode: 'decimal', value: x.amt, 'aria-label': 'Amount' });
    var sel = el('select', { class: 'lsw-in', 'aria-label': 'Unit' }, x.units.map(function (u, i) { var op = el('option', { value: String(i), text: u[0] }); if (i === x.ui) op.selected = true; return op; }));
    var add = el('button', { type: 'button', class: 'lsw-btn lsw-add', text: 'Add to meal' });
    var upd = function () {
      x.amt = amt.value; x.ui = +sel.value || 0;
      var c = f.calc(h, x.amt, x.units[x.ui]);
      out.textContent = '';
      if (!c) { out.appendChild(el('div', { class: 'lsw-v' }, ['Enter an amount.'])); add.disabled = true; return; }
      add.disabled = false;
      var t = totals();
      out.appendChild(el('div', { class: 'lsw-sub', text: c.k + ' kcal · ' + c.p + ' g protein · ' + c.c + ' g carbs · ' + c.f + ' g fat' }));
      out.appendChild(verdictBox(t.k + c.k, t.p + c.p));
    };
    amt.addEventListener('input', upd); sel.addEventListener('change', upd);
    add.addEventListener('click', function () {
      var c = f.calc(h, x.amt, x.units[x.ui]); if (!c) return;
      S.items.push({ n: h.n, label: c.label, k: c.k, p: c.p, c: c.c, f: c.f }); S.food = null; S.q = ''; draw();
    });
    body.appendChild(el('button', { type: 'button', class: 'lsw-link', text: '‹ Back to search', on: { click: function () { S.food = null; draw(); } } }));
    body.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-top:4px', text: h.n }));
    body.appendChild(el('div', { class: 'lsw-lbl', text: 'How much?' }));
    body.appendChild(el('div', { class: 'lsw-amt' }, [amt, sel]));
    body.appendChild(out); body.appendChild(add);
    upd();
  }

  // My own: say what it was. Known foods fill their own numbers (the page's parser); typed numbers always win.
  function drawOwn(body) {
    var w = S.own, auto = S.auto || (S.auto = {});
    var mk = function (key, label, ph, mode) {
      var i = el('input', { class: 'lsw-in', id: 'lsw-' + key, type: 'text', inputmode: mode || 'decimal', placeholder: ph, value: w[key] == null ? '' : String(w[key]), autocomplete: 'off' });
      i.addEventListener('input', function () { w[key] = i.value; if (key === 'name') parse(); refresh(); });
      return el('label', {}, [el('div', { class: 'lsw-lbl', text: label }), i]);
    };
    var vbox = el('div', {});
    var log = el('button', { type: 'button', class: 'lsw-btn lsw-log', text: S.saving ? 'Saving…' : 'Log swap' });
    var parse = function () {
      if (typeof window.parseFoodEntry !== 'function') return;
      try {
        var r = window.parseFoodEntry(w.name);
        if (!(r && r.items && r.items.length && r.totals.kcal)) return;
        [['k', r.totals.kcal], ['p', r.totals.p], ['c', r.totals.c], ['f', r.totals.f]].forEach(function (pr) {
          var s = String(pr[1]);
          if (w[pr[0]] === '' || w[pr[0]] == null || String(w[pr[0]]) === auto[pr[0]]) { w[pr[0]] = s; auto[pr[0]] = s; var n = document.getElementById('lsw-' + pr[0]); if (n) n.value = s; }
        });
      } catch (e) {}
    };
    var refresh = function () {
      vbox.textContent = ''; vbox.appendChild(verdictBox(num(w.k), num(w.p)));
      var v = judge(num(w.k), num(w.p));
      log.textContent = S.saving ? 'Saving…' : v.k === 'big' ? 'Log anyway' : 'Log swap';
      log.disabled = S.saving || !String(w.name).trim() || num(w.k) == null || num(w.p) == null;
    };
    body.appendChild(mk('name', 'What did you eat?', 'e.g. chicken kebab plate', 'text'));
    body.appendChild(el('div', { class: 'lsw-row' }, [mk('k', 'Calories', 'kcal'), mk('p', 'Protein (g)', 'g')]));
    if (w.more) body.appendChild(el('div', { class: 'lsw-row' }, [mk('c', 'Carbs (g)', 'g'), mk('f', 'Fat (g)', 'g')]));
    else body.appendChild(el('button', { type: 'button', class: 'lsw-link lsw-more', text: '+ Add carbs and fat', on: { click: function () { w.more = true; draw(); } } }));
    body.appendChild(vbox); body.appendChild(log);
    log.addEventListener('click', function () {
      if (log.disabled) return;
      save({ name: w.name, k: r0(num(w.k)), p: r0(num(w.p)), c: w.more && num(w.c) != null ? r0(num(w.c)) : '', f: w.more && num(w.f) != null ? r0(num(w.f)) : '' });
    });
    refresh();
  }

  function eatOut() {
    var idx = S.idx;
    var P = window.LockedInPlus;
    if (!P || typeof P.eatOut !== 'function') { S.tab = 'own'; draw(); return; }
    close();
    P.eatOut(idx);
  }

  function drawDone(sh) {
    var d = S.done;
    var fav = el('button', { type: 'button', class: 'lsw-link lsw-fav', text: d.fav ? '♥ Saved to favourites' : '♡ Save as favourite', disabled: d.fav ? '' : null, on: { click: function () {
      try { window.sw2SaveFavourite(); d.fav = true; draw(); } catch (e) {}
    } } });
    sh.appendChild(el('div', { class: 'lsw-bdy' }, [
      el('div', { class: 'lsw-done' }, [
        el('span', { class: 'ok', text: '✓' }),
        el('h4', { text: d.head }),
        el('p', { class: 'n', text: d.name }),
        el('p', { text: d.macros }),
        el('p', { text: d.verdict }),
        typeof window.sw2SaveFavourite === 'function' ? fav : null,
      ]),
      el('button', { type: 'button', class: 'lsw-btn lsw-donebtn', text: 'Done', on: { click: close } }),
    ]));
  }

  // ── boot ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function boot(opts) {
    try {
      if (o) return;
      if (!document.body.classList.contains('cv2')) return;        // V2 screens only
      if (typeof window.openSwapModal !== 'function' || !ready()) return;   // older pages keep their own pop-up
      o = opts || {}; BASE = o.base || BASE;
      orig = window.openSwapModal;
      window.openSwapModal = function (w, d, i) { return open(w, d, i); };
    } catch (e) {}
  }
  /* preset: another sheet (Eating out) hands a ready entry to the next open, which then starts on "My own". */
  function preset(p) { PRE = p || null; }

  window.LockedInSwap = { boot: boot, preset: preset, close: close, active: function () { return !!orig; } };
})();
