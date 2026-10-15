/* ==========================================================================
   LOCKED IN · Weigh-in trend, set logging + PRs, photo compare, eating out
   (Omar 2026-10-15)
   --------------------------------------------------------------------------
   Loaded by push-client.js (the shared script every client page includes) with
   the client's existing login. Nothing in the page is replaced; each part only
   adds to the V2 screens and is guarded on its own.
     Home       Daily weigh-in: log today's weight, a smoothed trend line, the
                weekly pace and "on pace for <goal> around <date>".
                (Daily weighing + a trend beats weekly single weigh-ins for
                adherence and for reading real change: Zheng 2015, Steinberg
                2013; MacroFactor / Happy Scale do the same.)
     Train      Reps pre-filled from last time (same set, in the prescribed
                range) so one tap logs; a new best set gets a PR moment.
     Progress   Photo compare: first vs latest of the same pose, side by side
                or with a slider.
     Nutrition  Eating out / travel: picks that fit the meal you're replacing;
                one tap pre-fills the page's own Swap form (the client logs it).
   Rules: textContent / escaped strings only; writes only through the page's own
   cloudWrite('weight') and Swap form; every entry point try/catch guarded.
   ========================================================================== */
(function () {
  'use strict';
  if (window.LockedInPlus) return;
  var o = null;
  var DAY = 864e5;
  var EAT_OUT_ON = false;   // Omar 2026-10-15: eating out on hold (built + tested, not shown)

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { n.addEventListener(e, attrs.on[e]); });
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svg(tag, attrs) { var n = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); return n; }
  var LS = function (k) { return 'lip_' + k + '_' + (o ? o.storageKey : ''); };
  function lsGet(k, d) { try { var v = localStorage.getItem(LS(k)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsPut(k, v) { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch (e) {} }
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function CC() { try { return typeof CLIENT_CONFIG !== 'undefined' ? CLIENT_CONFIG : (window.CLIENT_CONFIG || null); } catch (e) { return null; } }   // a top-level const, not on window
  function cfg() { var c = CC(); return (c && c.client) || {}; }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; }
  function localDay(t) { var d = new Date(t); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dayMs(s) { return new Date(s + 'T12:00:00').getTime(); }
  function fmtKg(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function fmtDate(ms, withYear) { try { return new Date(ms).toLocaleDateString('en-AU', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }); } catch (e) { return ''; } }
  function toast(msg) {
    var old = document.querySelector('.lip-toast'); if (old) old.remove();
    var t = el('div', { class: 'lip-toast', role: 'status', text: msg }); document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 2800);
  }
  function api(type, extra) {
    var tok = ''; try { tok = o.getToken() || ''; } catch (e) {}
    if (!tok) return Promise.reject(new Error('no_token'));
    return fetch(o.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ type: type, storageKey: o.storageKey, token: tok }, extra || {})) })
      .then(function (r) { return r.json(); });
  }

  function css() {
    if (document.getElementById('lip-css')) return;
    var s = document.createElement('style'); s.id = 'lip-css';
    s.textContent = [
      '.lip-card{background:var(--c-surface,#fff);border:1px solid var(--c-line,#e7e2d9);border-radius:var(--c-r,18px);box-shadow:var(--c-shadow,0 8px 24px -14px rgba(22,24,28,.18));padding:16px;margin:14px 0 0;color:var(--c-text,#16181c);font-family:inherit}',
      '.lip-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}',
      '.lip-head b{font-size:16px;font-weight:800;letter-spacing:-.01em}.lip-head span{font-size:12.5px;color:var(--c-muted,#5d636b);font-weight:600}',
      '.lip-big{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.lip-big b{font-size:30px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.lip-big small{font-size:13px;color:var(--c-muted,#5d636b);font-weight:600}',
      '.lip-pace{display:inline-block;font-size:12.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--c-surface2,#f5f3ef);color:var(--c-muted,#5d636b)}',
      '.lip-pace.good{background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48)}',
      '.lip-line{font-size:13.5px;line-height:1.45;margin:8px 0 0;color:var(--c-text,#16181c)}.lip-line.m{color:var(--c-muted,#5d636b);font-size:12.5px}',
      '.lip-spark{display:block;width:100%;height:74px;margin:10px 0 2px}',
      '.lip-row{display:flex;gap:8px;margin-top:12px;align-items:center}',
      '.lip-in{flex:1 1 auto;width:100%!important;min-width:0;margin:0;box-sizing:border-box;font:inherit;font-size:17px;font-weight:700;padding:11px 12px;border-radius:12px;border:1px solid var(--c-line2,#d9d3c8);background:var(--c-surface,#fff);color:var(--c-text,#16181c);font-variant-numeric:tabular-nums}',
      '.lip-btn{flex:0 0 auto;width:auto!important;margin:0;font:inherit;font-weight:800;font-size:14.5px;padding:11px 16px;border-radius:12px;border:0;background:var(--c-accent,#e8542e);color:#fff;cursor:pointer;white-space:nowrap}',
      '.lip-btn.ghost{background:transparent;color:var(--c-muted,#5d636b);border:1px solid var(--c-line,#e7e2d9);font-weight:700}',
      '.lip-btn[disabled]{opacity:.5}',
      '.lip-done{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48);font-weight:700;font-size:14px}',
      '.lip-done button{font:inherit;font-size:12.5px;font-weight:700;background:none;border:0;color:var(--c-muted,#5d636b);text-decoration:underline;cursor:pointer}',
      '.lip-warn{margin-top:8px;font-size:13px;color:var(--c-warn,#9a5b00);font-weight:600}',
      // set logging
      '.tv2-set .tv2-in.lip-pre{color:var(--c-dim,#8a8d93)!important;font-weight:600}',
      '@keyframes lipPop{0%{transform:translate(-50%,-20px) scale(.9);opacity:0}15%{transform:translate(-50%,0) scale(1.02);opacity:1}85%{opacity:1}100%{transform:translate(-50%,0) scale(1);opacity:0}}',
      '.lip-pr{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 12px);z-index:2147483000;transform:translateX(-50%);width:min(92vw,380px);background:#16181c;color:#fff;border-radius:18px;padding:14px 16px;display:flex;gap:12px;align-items:center;box-shadow:0 18px 40px -12px rgba(0,0,0,.45);animation:lipPop 4.2s ease forwards;pointer-events:none}',
      '.lip-pr .tro{font-size:30px;line-height:1}.lip-pr b{display:block;font-size:15.5px;font-weight:800;letter-spacing:-.01em}.lip-pr small{display:block;font-size:12.5px;opacity:.75;margin-top:2px}',
      '.lip-pr em{font-style:normal;color:#ffb199}',
      // photos
      '.lip-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}',
      '.lip-chip{font:inherit;font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:var(--c-muted,#5d636b);cursor:pointer}',
      '.lip-chip.on{background:var(--c-text,#16181c);color:var(--c-surface,#fff);border-color:var(--c-text,#16181c)}',
      '.lip-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.lip-ph{position:relative;border-radius:12px;overflow:hidden;background:var(--c-sunk,#ece8e1);aspect-ratio:3/4}',
      '.lip-ph img{width:100%;height:100%;object-fit:cover;display:block}',
      '.lip-ph span{position:absolute;left:6px;bottom:6px;font-size:11.5px;font-weight:700;background:rgba(0,0,0,.6);color:#fff;padding:3px 7px;border-radius:999px}',
      '.lip-slide{position:relative;border-radius:12px;overflow:hidden;background:var(--c-sunk,#ece8e1);aspect-ratio:3/4;touch-action:pan-y}',
      '.lip-slide img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '.lip-slide .top{clip-path:inset(0 50% 0 0)}',
      '.lip-slide .bar{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.4)}',
      '.lip-slide .bar:after{content:"⟷";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:#fff;color:#16181c;display:grid;place-items:center;font-size:14px;font-weight:800}',
      '.lip-slide .l,.lip-slide .r{position:absolute;bottom:6px;font-size:11.5px;font-weight:700;background:rgba(0,0,0,.6);color:#fff;padding:3px 7px;border-radius:999px}.lip-slide .l{left:6px}.lip-slide .r{right:6px}',
      '.lip-range{width:100%;margin:10px 0 0;accent-color:var(--c-accent,#e8542e)}',
      '.lip-sel{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}',
      '.lip-sel select{width:100%;min-width:0;margin:0;box-sizing:border-box;box-shadow:none;font:inherit;font-size:13px;padding:8px;border-radius:10px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:var(--c-text,#16181c)}',
      '.lip-mode{font:inherit;font-size:12.5px;font-weight:700;background:none;border:0;color:var(--c-accent,#e8542e);cursor:pointer;padding:0}',
      // eating out
      '.lip-eo{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;margin:0 0 12px;padding:12px 14px;border-radius:var(--c-r,16px);border:1px dashed var(--c-line2,#d9d3c8);background:var(--c-surface,#fff);color:var(--c-text,#16181c);cursor:pointer}',
      '.lip-eo .ic{font-size:20px}.lip-eo b{display:block;font-size:14.5px;font-weight:800}.lip-eo small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b)}.lip-eo i{margin-left:auto;font-style:normal;color:var(--c-muted,#5d636b);font-weight:800}',
      '.lip-bd{position:fixed;inset:0;background:rgba(10,12,16,.45);z-index:2147482000;display:flex;align-items:flex-end;justify-content:center}',
      '.lip-sh{background:var(--c-bg,#faf8f4);color:var(--c-text,#16181c);width:min(100%,560px);max-height:88vh;overflow:auto;border-radius:22px 22px 0 0;padding:18px 16px calc(20px + env(safe-area-inset-bottom));font-family:inherit;-webkit-overflow-scrolling:touch}',
      '.lip-sh h3{margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em}.lip-sh .sub{margin:4px 0 14px;font-size:13px;color:var(--c-muted,#5d636b)}',
      '.lip-x{float:right;font:inherit;font-size:22px;line-height:1;background:none;border:0;color:var(--c-muted,#5d636b);cursor:pointer;padding:2px 4px}',
      '.lip-tabs{display:flex;gap:6px;margin:0 0 12px}',
      '.lip-opt{display:flex;justify-content:space-between;gap:10px;align-items:center;width:100%;text-align:left;font:inherit;padding:12px;margin:0 0 8px;border-radius:14px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:inherit;cursor:pointer}',
      '.lip-opt b{display:block;font-size:14.5px;font-weight:700}.lip-opt small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin-top:2px}',
      '.lip-opt .k{flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums;font-weight:800;font-size:14px}.lip-opt .k small{font-weight:600}',
      '.lip-tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.02em;padding:2px 7px;border-radius:999px;margin-left:6px;vertical-align:1px}',
      '.lip-tag.fit{background:var(--c-ok-tint,#edf6f1);color:var(--c-ok,#0f7a48)}.lip-tag.over{background:var(--c-warn-tint,#fff4e0);color:var(--c-warn,#9a5b00)}.lip-tag.lite{background:var(--c-surface2,#f5f3ef);color:var(--c-muted,#5d636b)}',
      '.lip-tips{margin:6px 0 14px;padding:12px 14px;border-radius:14px;background:var(--c-surface2,#f5f3ef);font-size:13.5px;line-height:1.5}',
      '.lip-tips ul{margin:0;padding-left:18px}.lip-tips li{margin:2px 0}',
      '.lip-back{font:inherit;font-size:13px;font-weight:700;background:none;border:0;color:var(--c-accent,#e8542e);cursor:pointer;padding:0;margin:0 0 10px}',
      '.lip-note{font-size:12px;color:var(--c-muted,#5d636b);margin:6px 0 0}',
      '.lip-toast{position:fixed;left:16px;right:16px;bottom:calc(var(--c-nav-total,84px) + 12px);z-index:2147483000;background:#16181c;color:#fff;border-radius:14px;padding:12px 14px;font-size:14px;font-weight:600;box-shadow:0 12px 30px -10px rgba(0,0,0,.4);max-width:520px;margin:0 auto}',
    ].join('');
    document.head.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 1. DAILY WEIGH-IN + TREND + GOAL DATE (Home)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  var W = { rows: null, loadedAt: 0, loading: false, editing: false, warn: null };

  /* One value per local day (the last one logged that day), oldest first. Server rows + any weigh-in from this phone that
     the server hasn't returned yet. */
  function dailySeries() {
    var by = {};
    (W.rows || []).forEach(function (r) {
      var kg = num(r.weightKg), t = Date.parse(r.timestamp);
      if (kg == null || !(kg > 25 && kg < 350) || !isFinite(t)) return;
      var d = localDay(t);
      if (!by[d] || by[d].t <= t) by[d] = { t: t, kg: kg };
    });
    (lsGet('pending', []) || []).forEach(function (p) {
      if (!p || !p.d || !(p.kg > 25)) return;
      if (!by[p.d] || by[p.d].t <= p.t) by[p.d] = { t: p.t, kg: p.kg };
    });
    return Object.keys(by).sort().map(function (d) { return { d: d, ms: dayMs(d), kg: by[d].kg }; });
  }

  /* Time-aware exponential moving average (Hacker's Diet / Happy Scale style, ~10% per day): a weigh-in after a gap of
     g days moves the trend by 1-(0.9^g), so weekly check-ins still produce a sensible line. */
  function trendOf(series) {
    var out = [], t = null, prev = null;
    series.forEach(function (p) {
      if (t == null) t = p.kg;
      else { var g = Math.max(1, Math.round((p.ms - prev) / DAY)); var a = 1 - Math.pow(0.9, g); t = t + a * (p.kg - t); }
      prev = p.ms; out.push({ d: p.d, ms: p.ms, kg: p.kg, tr: t });
    });
    return out;
  }

  /* kg per week from a least-squares fit of the trend over the last 21 days. Needs 4+ weigh-ins spanning 10+ days. */
  function paceOf(tr) {
    var now = Date.now(), win = tr.filter(function (p) { return p.ms >= now - 21 * DAY; });
    if (win.length < 4 || (win[win.length - 1].ms - win[0].ms) < 10 * DAY) return null;
    var n = win.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    win.forEach(function (p) { var x = p.ms / DAY; sx += x; sy += p.tr; sxx += x * x; sxy += x * p.tr; });
    var den = n * sxx - sx * sx; if (!den) return null;
    return ((n * sxy - sx * sy) / den) * 7;
  }

  function sparkline(tr) {
    var now = Date.now(), pts = tr.filter(function (p) { return p.ms >= now - 35 * DAY; });
    if (pts.length < 2) return null;
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.kg, p.tr); hi = Math.max(hi, p.kg, p.tr); });
    var pad = Math.max(0.4, (hi - lo) * 0.15); lo -= pad; hi += pad;
    var x0 = pts[0].ms, x1 = Math.max(pts[pts.length - 1].ms, x0 + DAY);
    var X = function (ms) { return 6 + (ms - x0) / (x1 - x0) * 288; }, Y = function (kg) { return 66 - (kg - lo) / (hi - lo) * 58; };
    var s = svg('svg', { class: 'lip-spark', viewBox: '0 0 300 74', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    s.appendChild(svg('path', { d: pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.ms).toFixed(1) + ' ' + Y(p.tr).toFixed(1); }).join(' '),
      fill: 'none', stroke: 'var(--c-accent,#e8542e)', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    pts.forEach(function (p) { s.appendChild(svg('circle', { cx: X(p.ms).toFixed(1), cy: Y(p.kg).toFixed(1), r: '2.6', fill: 'var(--c-dim,#8a8d93)', opacity: '.75' })); });
    return s;
  }

  function weighCard() {
    var c = el('div', { class: 'lip-card', id: 'lip-weigh' });
    var series = dailySeries(), tr = trendOf(series), last = tr[tr.length - 1] || null;
    var today = localDay(Date.now()), todays = last && last.d === today ? last : null;
    var goal = num(cfg().goalWeight), start = num(cfg().startWeight);
    c.appendChild(el('div', { class: 'lip-head' }, [el('b', { text: 'Weigh-in' }), el('span', { text: tr.length ? 'Your trend' : 'Daily' })]));

    if (tr.length) {
      var pace = paceOf(tr);
      var big = el('div', { class: 'lip-big' }, [el('b', { text: fmtKg(last.tr) }), el('small', { text: 'kg trend' })]);
      var losing = goal != null && last.tr != null ? goal < last.tr : (start != null && goal != null ? goal < start : null);
      if (pace != null) {
        var good = losing === null ? false : (losing ? pace < -0.05 : pace > 0.05);
        big.appendChild(el('span', { class: 'lip-pace' + (good ? ' good' : ''), text: (pace > 0 ? '+' : pace < 0 ? '−' : '') + fmtKg(Math.abs(pace)) + ' kg / week' }));
      }
      c.appendChild(big);
      var sp = sparkline(tr); if (sp) c.appendChild(sp);
      var msg = null;
      if (goal != null && goal > 25) {
        var gap = last.tr - goal;
        if (Math.abs(gap) <= 0.3) msg = 'You\'ve reached your goal of ' + fmtKg(goal) + ' kg. 🎉';
        else if (pace != null && ((gap > 0 && pace < -0.05) || (gap < 0 && pace > 0.05))) {
          var weeks = Math.abs(gap / pace);
          if (weeks <= 78) msg = 'On pace for ' + fmtKg(goal) + ' kg around ' + fmtDate(Date.now() + weeks * 7 * DAY, weeks > 40) + '.';
          else msg = 'Heading the right way. Keep stacking days.';
        }
        else if (pace != null) msg = 'Trend is flat or heading the wrong way the last 3 weeks. Keep logging; ' + firstCoach() + ' will see it.';
        else msg = 'Weigh in most mornings and your goal date shows up here.';
      }
      if (msg) c.appendChild(el('p', { class: 'lip-line', text: msg }));
    } else {
      c.appendChild(el('p', { class: 'lip-line', text: 'Weigh in each morning and see your real trend, not the daily ups and downs.' }));
    }

    if (todays && !W.editing) {
      c.appendChild(el('div', { class: 'lip-done' }, [
        el('span', { text: '✓ ' + fmtKg(todays.kg) + ' kg today' }),
        el('button', { type: 'button', text: 'Change', on: { click: function () { W.editing = true; renderWeigh(); } } }),
      ]));
    } else {
      var inp = el('input', { class: 'lip-in', type: 'text', inputmode: 'decimal', placeholder: last ? fmtKg(last.kg) + ' kg' : 'Weight in kg', 'aria-label': 'Today\'s weight in kg', enterkeyhint: 'done' });
      var btn = el('button', { type: 'button', class: 'lip-btn', text: 'Log' });
      var go = function () { logWeight(inp.value, btn); };
      btn.addEventListener('click', go);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      c.appendChild(el('div', { class: 'lip-row' }, [inp, btn]));
      if (W.warn) c.appendChild(el('div', { class: 'lip-warn', text: W.warn.text }));
    }
    c.appendChild(el('p', { class: 'lip-line m', text: 'Morning, after the toilet, before food or water. Daily weight swings 1–2 kg with water and food; the line shows the real trend.' }));
    return c;
  }
  function firstCoach() { var c = CC(); return String((c && c.coach && c.coach.name) || 'Omar').split(' ')[0]; }

  function logWeight(raw, btn) {
    var kg = num(raw);
    if (kg == null || kg < 30 || kg > 300) { W.warn = { text: 'Enter your weight in kg, e.g. 82.4' }; renderWeigh(); return; }
    kg = Math.round(kg * 10) / 10;
    var tr = trendOf(dailySeries()), last = tr[tr.length - 1];
    if (last && Math.abs(kg - last.tr) > 3.5 && !(W.warn && W.warn.kg === kg)) {
      W.warn = { kg: kg, text: 'That\'s ' + fmtKg(Math.abs(kg - last.tr)) + ' kg off your trend. Tap Log again if it\'s right.' };
      renderWeigh(); var i = document.querySelector('#lip-weigh .lip-in'); if (i) i.value = String(kg); return;
    }
    if (typeof window.cloudWrite !== 'function') return;
    W.warn = null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving'; }
    var now = Date.now(), pend = (lsGet('pending', []) || []).filter(function (p) { return p && p.d !== localDay(now); });
    pend.push({ d: localDay(now), t: now, kg: kg }); lsPut('pending', pend.slice(-14));
    W.editing = false;
    Promise.resolve().then(function () { return window.cloudWrite('weight', { weightKg: kg, notes: 'daily weigh-in' }); })
      .then(function (r) {
        if (r && r.ok) { toast('Weigh-in saved'); loadWeights(true); }
        else toast('Saved on your phone. It sends when you\'re back online.');
        renderWeigh();
      }, function () { toast('Saved on your phone. It sends when you\'re back online.'); renderWeigh(); });
    renderWeigh();
  }

  function loadWeights(force) {
    if (W.loading || (!force && Date.now() - W.loadedAt < 10 * 60e3)) return;
    W.loading = true;
    api('weightLog').then(function (rows) {
      W.loading = false;
      if (!Array.isArray(rows)) return;
      W.rows = rows; W.loadedAt = Date.now();
      // forget pending weigh-ins the server now has (same day, same value)
      var have = {}; rows.forEach(function (r) { var t = Date.parse(r.timestamp); if (isFinite(t)) have[localDay(t) + '|' + Math.round(num(r.weightKg) * 10)] = 1; });
      lsPut('pending', (lsGet('pending', []) || []).filter(function (p) { return p && !have[p.d + '|' + Math.round(p.kg * 10)] && p.t > Date.now() - 14 * DAY; }));
      renderWeigh();
    }, function () { W.loading = false; });
  }

  function renderWeigh() {
    try {
      var home = document.getElementById('cv2-cv2home-page'); if (!home) return;
      var focused = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('lip-in') && home.contains(document.activeElement);
      if (focused) return;   // never yank the field out from under the client while they type
      var old = document.getElementById('lip-weigh');
      var card = weighCard();
      if (old) { old.replaceWith(card); return; }
      var week = document.getElementById('liw-home'), anchor = home.querySelector('.cv2-seclabel');
      if (week && week.parentNode) week.parentNode.insertBefore(card, week.nextSibling);
      else if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor);
      else home.appendChild(card);
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 2. FAST SET LOGGING + PR MOMENT (Train)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  function kgOf(w) { var n = num(String(w || '').replace(/kg/i, '')); return n != null && n > 0 ? n : null; }
  function repsOf(r) { var n = parseInt(String(r || ''), 10); return n > 0 && n <= 30 ? n : null; }
  function e1rm(w, r) { return w * (1 + r / 30); }   // Epley
  function sessionsStore() { return readJSON(o.storageKey + '_workout_sessions') || {}; }
  function allSessions() {
    var st = sessionsStore(), out = [];
    Object.keys(st).forEach(function (k) { (Array.isArray(st[k]) ? st[k] : []).forEach(function (s) { if (s) out.push({ key: k, s: s }); }); });
    return out;
  }

  /* Reps for set i, last time this exercise was done (a finished session), only if they sit inside the prescribed
     range (so a new phase with a different rep target never carries old reps). */
  function lastReps(name, i, presc) {
    var m = String(presc || '').match(/(\d{1,2})\s*(?:[-–to]+\s*(\d{1,2}))?/);
    if (!m || /\d\s*s\b|sec|min|amrap/i.test(String(presc))) return '';
    var lo = +m[1], hi = m[2] ? +m[2] : +m[1];
    var best = null;
    allSessions().forEach(function (x) {
      var s = x.s; if (s.status === 'open') return;
      var en = s.entries && s.entries[name]; if (!en || !Array.isArray(en.setLog) || !en.setLog.length) return;
      var t = Date.parse(s.completedAt || s.startedAt || '') || 0;
      if (!best || t > best.t) best = { t: t, sl: en.setLog };
    });
    if (!best) return '';
    var r = repsOf(best.sl[i] && best.sl[i].r) || repsOf(best.sl[best.sl.length - 1] && best.sl[best.sl.length - 1].r);
    return r && r >= lo && r <= hi ? String(r) : '';
  }

  function prefillReps() {
    try {
      var box = document.getElementById('tv2-workout'); if (!box) return;
      var nameEl = box.querySelector('.tv2-exname'); if (!nameEl) return;
      var row = box.querySelector('.tv2-set.now'); if (!row) return;
      var inp = row.querySelector('input[id^="tv2-r"]'); if (!inp || inp.value || inp.readOnly || inp.dataset.lip) return;
      var i = parseInt(inp.id.replace('tv2-r', ''), 10); if (!(i >= 0)) return;
      var r = lastReps(nameEl.textContent.trim(), i, inp.getAttribute('placeholder'));
      inp.dataset.lip = '1';
      if (!r) return;
      inp.value = r; inp.classList.add('lip-pre');
      inp.setAttribute('aria-label', (inp.getAttribute('aria-label') || '') + ' (pre-filled from last time)');
      var clear = function () { inp.classList.remove('lip-pre'); };
      inp.addEventListener('input', clear);
      inp.addEventListener('focus', function () { try { inp.select(); } catch (e) {} });
    } catch (e) {}
  }

  var PR = { celebrated: {} };
  /* Best set before this one: every other session's sets of the same exercise, plus legacy logs older than the
     current session. Null when there is no history (a first time is not a PR). */
  function priorBest(name, curKey, curSid, curStart) {
    var best = null;
    var take = function (w, r, t) { var k = kgOf(w), n = repsOf(r); if (k == null || n == null) return; var e = e1rm(k, n); if (!best || e > best.e) best = { e: e, w: k, r: n, t: t }; };
    allSessions().forEach(function (x) {
      var s = x.s; if (x.key === curKey && s.sid === curSid) return;   // sids count per day key
      var en = s.entries && s.entries[name]; if (!en) return;
      var t = Date.parse(s.completedAt || s.startedAt || '') || 0;
      if (Array.isArray(en.setLog) && en.setLog.length) en.setLog.forEach(function (st) { take(st && st.w, st && st.r, t); });
      else take(en.weight, en.reps, t);
    });
    var wl = readJSON(o.storageKey + '_workout_log') || {};
    Object.keys(wl).forEach(function (k) {
      var e = wl[k]; if (!e || e.exName !== name) return;
      var t = Date.parse(e.ts || '') || 0; if (curStart && t >= curStart) return;
      if (Array.isArray(e.setLog) && e.setLog.length) e.setLog.forEach(function (st) { take(st && st.w, st && st.r, t); });
      else take(e.weight, e.reps, t);
    });
    return best;
  }

  function afterLog(t0) {
    try {
      var hit = null;
      allSessions().forEach(function (x) {
        var s = x.s; if (s.status === 'abandoned') return;
        Object.keys(s.entries || {}).forEach(function (name) {
          (s.entries[name].setLog || []).forEach(function (st) { var t = Date.parse(st && st.ts || ''); if (t >= t0 && (!hit || t > hit.t)) hit = { t: t, name: name, st: st, s: s, key: x.key }; });
        });
      });
      if (!hit) return;
      var k = kgOf(hit.st.w), r = repsOf(hit.st.r); if (k == null || r == null) return;
      var tag = hit.key + '|' + hit.s.sid + '|' + hit.name; if (PR.celebrated[tag]) return;
      var prev = priorBest(hit.name, hit.key, hit.s.sid, Date.parse(hit.s.startedAt || '') || 0);
      if (!prev || e1rm(k, r) < prev.e + 0.5) return;
      PR.celebrated[tag] = Date.now();
      var heavier = k > prev.w;
      showPR(hit.name, k + ' kg × ' + r, (heavier ? 'Heaviest yet. ' : 'More reps at this weight. ') + 'Beats ' + prev.w + ' kg × ' + prev.r + (prev.t ? ' from ' + fmtDate(prev.t) : ''));
    } catch (e) {}
  }
  function showPR(name, set, sub) {
    var old = document.querySelector('.lip-pr'); if (old) old.remove();
    var n = el('div', { class: 'lip-pr', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'tro', text: '🏆' }),
      el('div', {}, [el('b', {}, ['New best · ', el('em', { text: set })]), el('small', { text: name + ' — ' + sub })]),
    ]);
    document.body.appendChild(n);
    setTimeout(function () { try { n.remove(); } catch (e) {} }, 4400);
    try { if (typeof window.fireConfetti === 'function') window.fireConfetti('small'); } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate([18, 40, 18]); } catch (e) {}
  }

  function hookTraining() {
    var wrap = function (fn) {
      var orig = window[fn]; if (typeof orig !== 'function' || orig.__lip) return;
      var w = function () { var t0 = Date.now() - 50; var res = orig.apply(this, arguments); setTimeout(function () { afterLog(t0); }, 0); return res; };
      w.__lip = true; window[fn] = w;
    };
    wrap('tv2LogSet');
    // The page's older PR burst (progression-table based) stays, but never doubles up on a set this script celebrated.
    var sc = window.showCelebration;
    if (typeof sc === 'function' && !sc.__lip) {
      var w2 = function (emoji, msg) {
        if (msg === 'NEW PR') { var now = Date.now(); for (var k in PR.celebrated) if (now - PR.celebrated[k] < 15 * 60e3) return; }
        return sc.apply(this, arguments);
      };
      w2.__lip = true; window.showCelebration = w2;
    }
    var box = document.getElementById('tv2-workout');
    if (box && window.MutationObserver) new MutationObserver(prefillReps).observe(box, { childList: true, subtree: true });
    prefillReps();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 3. PHOTO COMPARE (Progress)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  var P = { photos: null, at: 0, loading: false, view: null, a: null, b: null, slide: true, pos: 50 };
  var VIEWS = { front: 'Front', side: 'Side', back: 'Back' };
  function viewName(v) { return VIEWS[String(v || '').toLowerCase()] || (String(v || 'Photo').charAt(0).toUpperCase() + String(v || 'photo').slice(1)); }
  function photoLabel(p) { return (p.label || (p.week != null ? 'Week ' + p.week : 'Photo')) + ' · ' + fmtDate(Date.parse(p.ts)); }
  function byView() {
    var g = {};
    (P.photos || []).forEach(function (p) { if (!p || p.urlKind !== 'signed' || !p.url) return; var v = String(p.view || 'photo').toLowerCase(); (g[v] = g[v] || []).push(p); });
    Object.keys(g).forEach(function (v) { g[v].sort(function (x, y) { return Date.parse(x.ts) - Date.parse(y.ts); }); });
    return g;
  }
  function loadPhotos(force) {
    if (P.loading || (!force && P.photos && Date.now() - P.at < 10 * 60e3)) return;   // signed links last 15 min
    P.loading = true;
    api('photosGet').then(function (j) {
      P.loading = false;
      if (!j || j.ok !== true || !Array.isArray(j.photos)) return;
      P.photos = j.photos; P.at = Date.now(); renderPhotos();
    }, function () { P.loading = false; });
  }
  function photoCard() {
    var g = byView(), views = Object.keys(g).filter(function (v) { return g[v].length >= 2; });
    views.sort(function (a, b) { return (Object.keys(VIEWS).indexOf(a) + 9) % 9 - (Object.keys(VIEWS).indexOf(b) + 9) % 9; });
    var c = el('div', { class: 'lip-card', id: 'lip-photos' });
    c.appendChild(el('div', { class: 'lip-head' }, [el('b', { text: 'Then vs now' }), views.length ? el('button', { type: 'button', class: 'lip-mode', text: P.slide ? 'Side by side' : 'Slider', on: { click: function () { P.slide = !P.slide; renderPhotos(); } } }) : null]));
    if (!views.length) {
      var any = Object.keys(g).length;
      c.appendChild(el('p', { class: 'lip-line m', text: any ? 'Add photos at your next check-in and your first and latest show up here side by side.' : 'Add front, side and back photos with your check-in. You\'ll see them side by side here as you change.' }));
      return c;
    }
    if (!P.view || views.indexOf(P.view) < 0) { P.view = views[0]; P.a = P.b = null; }
    if (views.length > 1) c.appendChild(el('div', { class: 'lip-chips' }, views.map(function (v) {
      return el('button', { type: 'button', class: 'lip-chip' + (v === P.view ? ' on' : ''), text: viewName(v), on: { click: function () { P.view = v; P.a = P.b = null; renderPhotos(); } } });
    })));
    var list = g[P.view];
    var ia = P.a != null && P.a < list.length ? P.a : 0, ib = P.b != null && P.b < list.length ? P.b : list.length - 1;
    var A = list[ia], B = list[ib];
    if (P.slide) {
      var top = el('img', { class: 'top', src: A.url, alt: viewName(P.view) + ' photo, ' + photoLabel(A), loading: 'lazy' });
      var bar = el('div', { class: 'bar' });
      var box = el('div', { class: 'lip-slide' }, [el('img', { src: B.url, alt: viewName(P.view) + ' photo, ' + photoLabel(B), loading: 'lazy' }), top, bar, el('span', { class: 'l', text: A.label || 'Then' }), el('span', { class: 'r', text: B.label || 'Now' })]);
      var set = function (v) { P.pos = Math.max(0, Math.min(100, v)); top.style.clipPath = 'inset(0 ' + (100 - P.pos) + '% 0 0)'; bar.style.left = P.pos + '%'; };
      var drag = function (e) { var rc = box.getBoundingClientRect(); var x = (e.touches ? e.touches[0].clientX : e.clientX) - rc.left; set(x / rc.width * 100); };
      box.addEventListener('pointerdown', function (e) { drag(e); box.setPointerCapture && box.setPointerCapture(e.pointerId); box.onpointermove = drag; });
      box.addEventListener('pointerup', function () { box.onpointermove = null; });
      set(P.pos);
      var rng = el('input', { type: 'range', class: 'lip-range', min: '0', max: '100', value: String(P.pos), 'aria-label': 'Compare slider' });
      rng.addEventListener('input', function () { set(+rng.value); });
      c.appendChild(box); c.appendChild(rng);
    } else {
      c.appendChild(el('div', { class: 'lip-pair' }, [
        el('div', { class: 'lip-ph' }, [el('img', { src: A.url, alt: viewName(P.view) + ' photo, ' + photoLabel(A), loading: 'lazy' }), el('span', { text: A.label || 'Then' })]),
        el('div', { class: 'lip-ph' }, [el('img', { src: B.url, alt: viewName(P.view) + ' photo, ' + photoLabel(B), loading: 'lazy' }), el('span', { text: B.label || 'Now' })]),
      ]));
    }
    var mk = function (cur, which) {
      var s = el('select', { 'aria-label': which === 'a' ? 'Compare from' : 'Compare to' }, list.map(function (p, i) { var op = el('option', { value: String(i), text: photoLabel(p) }); if (i === cur) op.selected = true; return op; }));
      s.addEventListener('change', function () { P[which] = +s.value; renderPhotos(); });
      return s;
    };
    c.appendChild(el('div', { class: 'lip-sel' }, [mk(ia, 'a'), mk(ib, 'b')]));
    var wa = A.baselineWeight, days = Math.round((Date.parse(B.ts) - Date.parse(A.ts)) / DAY);
    c.appendChild(el('p', { class: 'lip-note', text: (days > 0 ? days + ' days apart. ' : '') + (wa ? 'Starting weight ' + fmtKg(wa) + ' kg. ' : '') + 'Same light and pose each time makes the change easier to see.' }));
    return c;
  }
  function renderPhotos() {
    try {
      var sec = document.getElementById('section-tracker'); if (!sec) return;
      var old = document.getElementById('lip-photos'), card = photoCard();
      if (old) { old.replaceWith(card); return; }
      var top = document.getElementById('cv2-progress-top');
      if (top && top.parentNode) top.parentNode.insertBefore(card, top.nextSibling);
      else return;
    } catch (e) {}
  }
  function trackerShown() { var s = document.getElementById('section-tracker'); return !!(s && s.offsetParent !== null && getComputedStyle(s).display !== 'none'); }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 4. EATING OUT / TRAVEL (Nutrition)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  /* Typical restaurant portions, approximate (chain nutrition panels + AUSNUT averages). [name, how to order, kcal, P, C, F] */
  var EAT = [
    { id: 'charcoal', name: 'Charcoal chicken / Lebanese', ic: '🍗', tips: ['Chicken first: breast, skin off.', 'Garlic sauce on the side: 1 tbsp is ~100 kcal.', 'Tabouli or salad instead of chips.', 'Skip the bread basket or have half.'], items: [
      ['Quarter chicken (breast), skin off + tabouli', 'Garlic sauce on the side', 420, 52, 15, 16],
      ['Half chicken, skin off + salad', 'Garlic on the side', 640, 85, 12, 26],
      ['Chicken shish plate, rice + salad', 'Light garlic, no chips', 760, 58, 82, 20],
      ['Chicken shawarma wrap', 'Light garlic, extra salad', 560, 38, 56, 19],
      ['Mixed grill plate, no chips', 'Shish + kafta, salad', 820, 70, 25, 46],
      ['Falafel wrap', 'Hummus, salad', 600, 18, 74, 25],
      ['Chicken plate with chips + full garlic', 'Treat-size', 1350, 60, 110, 72],
    ] },
    { id: 'kebab', name: 'Kebab / Turkish', ic: '🥙', tips: ['Chicken or mixed, not lamb-heavy.', 'One sauce, light. Chilli is free.', 'Snack packs are 1,500+ kcal: share one or skip.'], items: [
      ['Chicken kebab', 'Light sauce, extra salad', 650, 42, 66, 22],
      ['Chicken shish plate + salad, no rice', 'Sauce on the side', 480, 55, 15, 20],
      ['Turkish pide, chicken', 'Half of one', 520, 30, 60, 17],
      ['Lamb kebab, garlic + BBQ', 'Treat-size', 950, 40, 75, 52],
      ['HSP (halal snack pack), small', 'Share it', 1500, 55, 110, 90],
    ] },
    { id: 'burger', name: 'Burgers', ic: '🍔', tips: ['Grilled chicken beats crumbed.', 'No mayo / aioli: saves 100–200 kcal.', 'Side salad or share the chips.', 'Water or zero-sugar drink.'], items: [
      ['Grilled chicken burger', 'No mayo, side salad', 520, 40, 48, 17],
      ['Single beef burger', 'No mayo, side salad', 600, 34, 45, 29],
      ['Lettuce-wrap beef burger', 'Low-carb', 420, 32, 9, 27],
      ['Double beef + cheese burger', 'No chips', 850, 52, 46, 50],
      ['Burger + chips + soft drink', 'Treat-size', 1300, 38, 150, 58],
    ] },
    { id: 'periperi', name: 'Peri-peri chicken', ic: '🌶️', tips: ['Breast over thigh for more protein per kcal.', 'Corn, salad or rice as the side. Chips are the trap.', 'Hot sauce is basically free.'], items: [
      ['Quarter chicken breast + side salad', '', 400, 48, 10, 18],
      ['Chicken breast wrap', '', 560, 42, 55, 18],
      ['Double chicken breast + rice', '', 760, 76, 80, 12],
      ['Chicken burger + corn', '', 640, 42, 62, 22],
      ['Half chicken + chips', 'Treat-size', 1150, 80, 70, 60],
    ] },
    { id: 'japanese', name: 'Sushi / Japanese', ic: '🍣', tips: ['Sashimi and teriyaki chicken are the protein wins.', 'Hand rolls are ~180 kcal each and low protein; 4 is a meal.', 'Skip tempura and mayo rolls.'], items: [
      ['Salmon sashimi (10) + edamame', '', 460, 46, 12, 25],
      ['Chicken teriyaki don, regular', '', 700, 36, 105, 13],
      ['4 hand rolls (chicken / tuna)', '', 720, 28, 120, 12],
      ['Chicken katsu curry', 'Treat-size', 1050, 40, 120, 42],
    ] },
    { id: 'mexican', name: 'Mexican', ic: '🌯', tips: ['Bowl instead of burrito saves the tortilla (~300 kcal).', 'Chicken + beans + salsa; go easy on cheese, sour cream, guac.'], items: [
      ['Chicken burrito bowl', 'No cheese / sour cream', 600, 45, 66, 16],
      ['Chicken burrito, regular', 'Salsa, no sour cream', 850, 50, 100, 25],
      ['2 chicken tacos', 'Soft shells', 480, 32, 44, 18],
      ['Nachos with everything', 'Treat-size', 1300, 45, 110, 75],
    ] },
    { id: 'pizza', name: 'Pizza / Italian', ic: '🍕', tips: ['Thin crust, chicken or seafood toppings.', 'Have 2–3 slices with a salad, not the whole pizza.', 'Tomato-based pasta beats creamy.'], items: [
      ['2 slices thin-crust chicken pizza + salad', '', 560, 30, 60, 21],
      ['3 slices thin-crust chicken pizza', '', 780, 42, 90, 28],
      ['Chicken pasta, tomato sauce', 'Regular size', 780, 45, 100, 20],
      ['Large pizza, whole', 'Treat-size', 2000, 85, 220, 80],
    ] },
    { id: 'indian', name: 'Indian', ic: '🍛', tips: ['Tandoori and tikka are grilled: best picks.', 'Creamy curries (butter, korma) are heavy; share one.', '1 roti or 1 cup rice, not both.'], items: [
      ['Tandoori chicken (half) + salad', '', 460, 56, 10, 21],
      ['Chicken tikka + 1 roti', '', 560, 46, 40, 21],
      ['Butter chicken + 1 cup rice', '', 860, 40, 85, 38],
      ['Curry + rice + garlic naan', 'Treat-size', 1400, 45, 160, 60],
    ] },
    { id: 'asian', name: 'Thai / Chinese', ic: '🥡', tips: ['Stir-fries with chicken or beef + steamed rice.', 'Fried rice, pad thai and honey chicken run 900+.', 'Ask for less oil.'], items: [
      ['Chicken + veg stir-fry, steamed rice', '', 640, 40, 80, 16],
      ['Beef + broccoli, steamed rice', '', 700, 40, 80, 22],
      ['Pad thai, chicken', '', 880, 35, 100, 34],
      ['Honey chicken + fried rice', 'Treat-size', 1300, 40, 170, 48],
    ] },
    { id: 'subs', name: 'Subs / sandwiches', ic: '🥪', tips: ['Double the meat, skip the cheese.', 'Sweet chilli or mustard over mayo-based sauces.', 'Wholemeal or a wrap.'], items: [
      ['6-inch chicken breast sub', 'Double meat, no cheese, light sauce', 480, 46, 47, 9],
      ['Footlong chicken sub', 'No cheese, light sauce', 720, 56, 95, 12],
      ['Chicken + salad wrap (café)', '', 480, 32, 45, 17],
    ] },
    { id: 'cafe', name: 'Café / brunch', ic: '☕', tips: ['Eggs are your protein. Ask for 3.', 'Skip the hash brown and hollandaise.', 'Iced coffee and smoothies can be 300–500 kcal.'], items: [
      ['3 eggs on 1 slice sourdough', 'Poached or scrambled', 380, 24, 26, 18],
      ['Omelette + 1 toast', 'Chicken / veg', 480, 34, 26, 26],
      ['Chicken + avocado on toast', '', 560, 36, 40, 26],
      ['Big breakfast (eggs, sausage, hash brown, toast)', 'Treat-size', 1100, 45, 70, 70],
    ] },
  ];
  var TRAVEL = [
    ['Airport / flights', ['Chicken wrap or sushi + a protein bar or yoghurt.', 'Pack a shaker with whey: add water after security.', 'Skip the pastries and lollies: 400–600 kcal you won\'t notice.']],
    ['Hotel breakfast', ['Build it like your plan: eggs or yoghurt first, then fruit and 1–2 toast.', 'Pastries, hash browns and juice are the traps.']],
    ['Servo / road trip', ['Protein milk (~30 g protein), jerky, nuts (small handful), bananas.', 'Big chocolate milk is a meal (~600 kcal).']],
    ['Training away', ['Do the session anyway: on Train, tap Swap exercise if the gym doesn\'t have something.', 'No gym: push-ups, squats, lunges, backpack rows. Same sets, high reps, close to failure.', 'Walk: aim for your step goal in a new city.']],
    ['How to log', ['Eating out: tap Eating out on the meal you\'re replacing, pick the closest option, then Log swap.', 'Not sure? Pick the bigger number. Rough is better than nothing.']],
  ];

  function openMeals() {
    var out = [];
    [].slice.call(document.querySelectorAll('#cv2-nutri .cv2-meal:not(.note)')).forEach(function (m) {
      if (/\bis-(ate|swap|skip)\b/.test(m.className)) return;
      var b = m.querySelector('.cv2-meal-h .tx b'), k = m.querySelector('.kc'), p = m.querySelector('.cv2-macros b'), sw = m.querySelector('button[onclick*="cv2Meal(\'swap\'"]');
      var idx = sw ? (String(sw.getAttribute('onclick')).match(/cv2Meal\('swap',\s*(\d+)\)/) || [])[1] : null;
      if (idx == null) return;
      var when = m.querySelector('.cv2-meal-h .when');
      out.push({ i: +idx, name: b ? b.textContent.trim() : 'Meal', when: when ? when.textContent.trim() : '', cal: parseInt((k && k.textContent) || '0', 10) || 0, p: parseInt((p && p.textContent) || '0', 10) || 0 });
    });
    return out;
  }
  var S = { meal: null, cuisine: null, tab: 'out' };
  function closeSheet() { var b = document.getElementById('lip-bd'); if (b) b.remove(); document.removeEventListener('keydown', escKey); }
  function escKey(e) { if (e.key === 'Escape') closeSheet(); }
  function sheet(build) {
    closeSheet();
    var sh = el('div', { class: 'lip-sh', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Eating out' });
    var bd = el('div', { class: 'lip-bd', id: 'lip-bd', on: { click: function (e) { if (e.target === bd) closeSheet(); } } }, [sh]);
    build(sh);
    document.body.appendChild(bd);
    document.addEventListener('keydown', escKey);
  }
  function fitTag(kcal, target) {
    if (!target) return null;
    var r = kcal / target;
    if (r > 1.6) return { cls: 'over', text: 'Treat' };
    if (r > 1.15) return { cls: 'over', text: '+' + Math.round(kcal - target) + ' kcal' };
    if (r < 0.85) return { cls: 'lite', text: '−' + Math.round(target - kcal) + ' kcal' };
    return { cls: 'fit', text: 'Fits' };
  }
  function renderSheet(sh) {
    sh.innerHTML = '';
    sh.appendChild(el('button', { type: 'button', class: 'lip-x', 'aria-label': 'Close', text: '×', on: { click: closeSheet } }));
    sh.appendChild(el('h3', { text: S.tab === 'travel' ? 'Travelling' : 'Eating out' }));
    var tabs = el('div', { class: 'lip-tabs' }, [['out', 'Eating out'], ['travel', 'Travelling']].map(function (t) {
      return el('button', { type: 'button', class: 'lip-chip' + (S.tab === t[0] ? ' on' : ''), text: t[1], on: { click: function () { S.tab = t[0]; renderSheet(sh); } } });
    }));
    if (S.tab === 'travel') {
      sh.appendChild(el('p', { class: 'sub', text: 'Stay on track away from home. Nothing here changes your plan.' }));
      sh.appendChild(tabs);
      TRAVEL.forEach(function (t) { sh.appendChild(el('div', { class: 'lip-tips' }, [el('b', { text: t[0] }), el('ul', {}, t[1].map(function (x) { return el('li', { text: x }); }))])); });
      return;
    }
    var meals = openMeals();
    if (!S.meal) {
      sh.appendChild(el('p', { class: 'sub', text: 'Which meal are you eating out for? You\'ll get picks that fit it.' }));
      sh.appendChild(tabs);
      if (!meals.length) { sh.appendChild(el('p', { class: 'lip-line m', text: 'Every meal on this day is already logged.' })); return; }
      meals.forEach(function (m) {
        sh.appendChild(el('button', { type: 'button', class: 'lip-opt', on: { click: function () { S.meal = m; renderSheet(sh); } } }, [
          el('span', {}, [el('b', { text: m.name }), el('small', { text: (m.when ? m.when + ' · ' : '') + m.p + ' g protein' })]),
          el('span', { class: 'k' }, [String(m.cal), el('small', { text: ' kcal' })]),
        ]));
      });
      return;
    }
    var m = S.meal;
    if (!S.cuisine) {
      sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: '‹ Change meal', on: { click: function () { S.meal = null; renderSheet(sh); } } }));
      sh.appendChild(el('p', { class: 'sub', text: 'Instead of ' + m.name + ' (' + m.cal + ' kcal, ' + m.p + ' g protein). Where are you eating?' }));
      EAT.forEach(function (c) {
        sh.appendChild(el('button', { type: 'button', class: 'lip-opt', on: { click: function () { S.cuisine = c.id; renderSheet(sh); } } }, [
          el('span', {}, [el('b', { text: c.ic + '  ' + c.name })]), el('span', { class: 'k', text: '›' }),
        ]));
      });
      return;
    }
    var cu = EAT.filter(function (c) { return c.id === S.cuisine; })[0];
    sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: '‹ ' + cu.name, on: { click: function () { S.cuisine = null; renderSheet(sh); } } }));
    sh.appendChild(el('p', { class: 'sub', text: 'Your ' + m.name.toLowerCase() + ' budget: ' + m.cal + ' kcal, ' + m.p + ' g protein. Tap one to log it.' }));
    sh.appendChild(el('div', { class: 'lip-tips' }, [el('ul', {}, cu.tips.map(function (x) { return el('li', { text: x }); }))]));
    var items = cu.items.slice().sort(function (a, b) {
      var sa = Math.abs(a[2] - m.cal) / (m.cal || 1) - Math.min(a[3] / (m.p || 1), 1.2) * 0.25, sb = Math.abs(b[2] - m.cal) / (m.cal || 1) - Math.min(b[3] / (m.p || 1), 1.2) * 0.25;
      return sa - sb;
    });
    items.forEach(function (it) {
      var tg = fitTag(it[2], m.cal);
      sh.appendChild(el('button', { type: 'button', class: 'lip-opt', on: { click: function () { logOut(m, cu, it); } } }, [
        el('span', {}, [el('b', {}, [it[0], tg ? el('span', { class: 'lip-tag ' + tg.cls, text: tg.text }) : null]), el('small', { text: (it[1] ? it[1] + ' · ' : '') + it[3] + ' g protein' })]),
        el('span', { class: 'k' }, ['~' + it[2], el('small', { text: ' kcal' })]),
      ]));
    });
    sh.appendChild(el('p', { class: 'lip-note', text: 'Numbers are typical restaurant portions, so treat them as a guide. You can adjust before logging.' }));
  }
  /* Hands over to the page's own Swap form for that meal, pre-filled. The client still taps "Log swap" there. */
  function logOut(m, cu, it) {
    closeSheet();
    try { window.cv2Meal('swap', m.i); } catch (e) { return; }
    var tries = 0;
    (function fill() {
      var d = document.getElementById('sw-desc');
      if (!d || d.offsetParent === null) { if (++tries < 20) return setTimeout(fill, 60); return; }
      var set = function (id, v) { var n = document.getElementById(id); if (n) { n.value = String(v); try { n.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} } };
      try { var ex = document.getElementById('sw2-extra'); if (ex && ex.hidden && typeof window.sw2ToggleExtra === 'function') window.sw2ToggleExtra(); } catch (e) {}
      set('sw-desc', it[0] + ' (' + cu.name + ')'); set('sw-cal', it[2]); set('sw-p', it[3]); set('sw-c', it[4]); set('sw-f', it[5]);
    })();
  }
  function openEatOut() { S = { meal: null, cuisine: null, tab: 'out' }; var o1 = openMeals(); if (o1.length === 1) S.meal = o1[0]; sheet(renderSheet); }
  function renderEatOut() {
    try {
      var box = document.getElementById('cv2-nutri'); if (!box || document.getElementById('lip-eo')) return;
      var first = box.querySelector('.cv2-meal'); if (!first || !first.parentNode) return;
      var b = el('button', { type: 'button', class: 'lip-eo', id: 'lip-eo', on: { click: openEatOut } }, [
        el('span', { class: 'ic', text: '🍽️' }),
        el('span', {}, [el('b', { text: 'Eating out or travelling?' }), el('small', { text: 'Picks that fit your plan, ready to log' })]),
        el('i', { text: '›' }),
      ]);
      first.parentNode.insertBefore(b, first);
    } catch (e) {}
  }

  // ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function boot(opts) {
    try {
      if (o || !opts || !opts.storageKey || typeof opts.getToken !== 'function' || !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api$/.test(opts.apiUrl || '')) return;
      if (!document.body.classList.contains('cv2')) return;   // V2 screens only
      o = opts; css();
      var watch = function (id, fn, deep) { var n = document.getElementById(id); if (n && window.MutationObserver) new MutationObserver(fn).observe(n, { childList: true, subtree: !!deep }); };
      watch('cv2-cv2home-page', function () { if (!document.getElementById('lip-weigh')) renderWeigh(); });
      if (EAT_OUT_ON) watch('section-nutrition', function () { renderEatOut(); }, true);
      watch('section-tracker', function () { if (!document.getElementById('lip-photos') && P.photos) renderPhotos(); });
      try { hookTraining(); } catch (e) {}
      // Photos load only when Progress is opened (signed links are short-lived)
      var nav = document.getElementById('cv2-nav');
      if (nav) nav.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-id]'); if (b && b.getAttribute('data-id') === 'tracker') setTimeout(function () { loadPhotos(); renderPhotos(); }, 60); });
      if (trackerShown()) loadPhotos();
      document.addEventListener('visibilitychange', function () { if (!document.hidden) { loadWeights(); if (trackerShown()) loadPhotos(); } });
      renderWeigh(); if (EAT_OUT_ON) renderEatOut();
      loadWeights(true);
    } catch (e) {}
  }
  window.LockedInPlus = { boot: boot, _t: { trendOf: trendOf, paceOf: paceOf, lastReps: lastReps, priorBest: priorBest, fitTag: fitTag, eatOut: function () { EAT_OUT_ON = true; renderEatOut(); } } };
})();
