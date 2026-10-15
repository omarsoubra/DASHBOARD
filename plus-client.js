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
  var EAT_OUT_ON = true;    // Omar 2026-10-15: GO (GYG, KFC, Nando's, Oporto, Subway + lighter orders)

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
      '.lip-chains{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0 6px}',
      '.lip-chain{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px;border-radius:16px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);color:inherit;font:inherit;cursor:pointer;text-align:left}',
      '.lip-chain .ic{font-size:26px;line-height:1}.lip-chain b{font-size:15px;font-weight:800}',
      '.lip-seclabel{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--c-muted,#5d636b);margin:16px 0 8px}',
      '.lip-tips li b{display:block;font-size:13.5px;font-weight:700}.lip-tips li small{display:block;font-size:12.5px;color:var(--c-muted,#5d636b);margin:1px 0 6px}',
      '.lip-search{display:block;font-size:15px;font-weight:500;margin:0 0 10px}',
      '.lip-groups{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;scrollbar-width:none}.lip-groups .lip-chip{flex:0 0 auto}',
      '.lip-gname{font-size:13px;font-weight:800;margin:14px 0 6px}',
      '.lip-swaps{margin:14px 0 0;padding:10px 12px;border-radius:14px;border:1px solid var(--c-line,#e7e2d9);background:var(--c-surface,#fff);font-size:13px}',
      '.lip-swaps summary{cursor:pointer;font-weight:700}.lip-swaps ul{margin:8px 0 0;padding-left:18px}.lip-swaps li{margin:0 0 6px}.lip-swaps b{font-weight:700}.lip-swaps small{display:block;color:var(--c-muted,#5d636b)}',
      '.lip-lite{color:var(--c-ok,#0f7a48)!important;font-weight:700}',
      '.lip-tip{color:var(--c-muted,#5d636b)!important;margin-top:3px!important}',
      '.lip-choice.on{border-color:var(--c-ok,#0f7a48);box-shadow:0 0 0 1px var(--c-ok,#0f7a48) inset}',
      '.lip-mods{margin:6px 0 2px;padding-left:16px;font-size:13px}.lip-mods li{margin:2px 0}.lip-mods i{font-style:normal;font-weight:700;color:var(--c-ok,#0f7a48);margin-left:6px}',
      '.lip-act{color:var(--c-accent,#e8542e)!important;font-weight:700;margin-top:6px!important}',
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
  // 4. EATING OUT (Nutrition): GYG, KFC, Nando's, Oporto, Subway
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  /* Menus come from eatout-data.js (next to this file): each chain's OFFICIAL Australian nutrition figures, pork and bacon
     left out. Loaded only when the sheet opens.
     Item = [name, kcal, P, C, F, lighter|0, tip?]; lighter = [order as, kcal, P, C, F, [[change, kcal delta], ...]] built
     from the chain's published modifier / component figures. */
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
  var S = { meal: null, chain: null, group: null, q: '', more: false, detail: null };
  var EOD = null, EODloading = null;
  function loadMenus() {
    if (EOD) return Promise.resolve(EOD);
    if (window.LockedInEatOutData) return Promise.resolve(EOD = window.LockedInEatOutData);
    if (EODloading) return EODloading;
    EODloading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      var me = document.querySelector('script[src*="plus-client.js"]');
      s.src = me ? me.src.replace(/plus-client\.js.*$/, 'eatout-data.js') : '../../eatout-data.js';
      s.async = true;
      s.onload = function () { EOD = window.LockedInEatOutData || null; EOD ? res(EOD) : rej(new Error('no_data')); };
      s.onerror = function () { EODloading = null; rej(new Error('load_failed')); };
      document.head.appendChild(s);
    });
    return EODloading;
  }
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
  function vals(it, lite) { var L = lite && it[5]; return L ? { name: L[0], k: L[1], p: L[2], c: L[3], f: L[4] } : { name: it[0], k: it[1], p: it[2], c: it[3], f: it[4] }; }
  /* Best picks: main dishes ranked by how close they land to the meal's calories, protein as the tie-breaker, fried /
     creamy picks sink. When the meal is tight, an item's lighter order competes too (and usually wins). */
  function bestPicks(ch, m) {
    var cand = [];
    ch.g.forEach(function (g) { if (g.main) g.i.forEach(function (it) { cand.push({ it: it, lite: false }); if (it[5]) cand.push({ it: it, lite: true }); }); });
    var score = function (x) {
      var v = vals(x.it, x.lite), fatPct = v.k ? v.f * 9 / v.k : 0;
      return Math.abs(v.k - m.cal) / (m.cal || 1) - Math.min(v.p / (m.p || 1), 1.3) * 0.45 + Math.max(0, fatPct - 0.35) * 1.2;
    };
    var seen = {}, out = [];
    cand.filter(function (x) { var v = vals(x.it, x.lite); return v.k > 0 && v.k <= m.cal * 1.2; })
      .sort(function (a, b) { return score(a) - score(b); })
      .forEach(function (x) { if (out.length < 6 && !seen[x.it[0]]) { seen[x.it[0]] = 1; out.push(x); } });
    return out;
  }
  function itemRow(it, ch, m, lite) {
    var v = vals(it, lite), tg = fitTag(v.k, m.cal), L = it[5];
    var kids = [el('b', {}, [v.name, tg ? el('span', { class: 'lip-tag ' + tg.cls, text: tg.text }) : null]),
      el('small', { text: v.p + ' g protein · ' + v.c + ' g carbs · ' + v.f + ' g fat' })];
    if (lite) kids.push(el('small', { class: 'lip-lite', text: '✓ Lighter order: ' + (it[1] - v.k) + ' kcal less than standard' }));
    else if (L) kids.push(el('small', { class: 'lip-lite', text: 'Lighter: ' + L[1] + ' kcal (' + L[5].map(function (x) { return x[0].toLowerCase(); }).join(', ') + ')' }));
    if (!lite && it[6]) kids.push(el('small', { class: 'lip-tip', text: '💡 ' + it[6] }));
    return el('button', { type: 'button', class: 'lip-opt', on: { click: function () { if (L) { S.detail = { it: it, lite: !!lite }; renderSheet(document.querySelector('.lip-sh')); } else logOut(m, ch, v); } } }, [
      el('span', {}, kids),
      el('span', { class: 'k' }, [String(v.k), el('small', { text: ' kcal' })]),
    ]);
  }
  function renderDetail(sh, ch, m) {
    var it = S.detail.it, L = it[5], std = vals(it, false), lt = vals(it, true);
    sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: '‹ ' + ch.name, on: { click: function () { S.detail = null; renderSheet(sh); } } }));
    sh.appendChild(el('p', { class: 'sub', text: it[0] + '. Your ' + m.name.toLowerCase() + ' budget: ' + m.cal + ' kcal, ' + m.p + ' g protein.' }));
    var card = function (title, v, sub, list, primary) {
      var tg = fitTag(v.k, m.cal);
      return el('button', { type: 'button', class: 'lip-opt lip-choice' + (primary ? ' on' : ''), on: { click: function () { logOut(m, ch, v); } } }, [
        el('span', {}, [el('b', {}, [title, tg ? el('span', { class: 'lip-tag ' + tg.cls, text: tg.text }) : null]), el('small', { text: sub }),
          list ? el('ul', { class: 'lip-mods' }, list.map(function (x) { return el('li', {}, [x[0], el('i', { text: (x[1] > 0 ? '+' : '−') + Math.abs(x[1]) + ' kcal' })]); })) : null,
          el('small', { class: 'lip-act', text: 'Log this →' })]),
        el('span', { class: 'k' }, [String(v.k), el('small', { text: ' kcal' })]),
      ]);
    };
    var lighterFirst = std.k > m.cal * 1.05;
    var a = card('Lighter order', lt, 'Ask for: ' + L[0] + ' · ' + lt.p + ' g protein', L[5], lighterFirst);
    var b = card('As it comes', std, std.p + ' g protein · ' + std.c + ' g carbs · ' + std.f + ' g fat', null, !lighterFirst);
    if (lighterFirst) { sh.appendChild(a); sh.appendChild(b); } else { sh.appendChild(b); sh.appendChild(a); }
    sh.appendChild(el('p', { class: 'lip-note', text: 'Lighter numbers use ' + ch.name + (/s$/.test(ch.name) ? '\'' : '\'s') + ' published figures for each change.' }));
  }
  function renderSheet(sh) {
    sh.innerHTML = '';
    sh.appendChild(el('button', { type: 'button', class: 'lip-x', 'aria-label': 'Close', text: '×', on: { click: closeSheet } }));
    sh.appendChild(el('h3', { text: 'Eating out' }));
    var meals = openMeals();
    if (!S.meal) {
      sh.appendChild(el('p', { class: 'sub', text: 'Which meal are you eating out for? You\'ll get picks that fit it.' }));
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
    if (!EOD) {
      sh.appendChild(el('p', { class: 'sub', text: 'Loading menus…' }));
      loadMenus().then(function () { if (document.body.contains(sh)) renderSheet(sh); }, function () { if (document.body.contains(sh)) { sh.lastChild.textContent = 'Couldn\'t load the menus. Check your connection and try again.'; } });
      return;
    }
    if (!S.chain) {
      if (meals.length > 1) sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: '‹ Change meal', on: { click: function () { S.meal = null; renderSheet(sh); } } }));
      sh.appendChild(el('p', { class: 'sub', text: 'Instead of ' + m.name + ' (' + m.cal + ' kcal, ' + m.p + ' g protein). Where are you eating?' }));
      sh.appendChild(el('div', { class: 'lip-chains' }, EOD.chains.map(function (c) {
        return el('button', { type: 'button', class: 'lip-chain', on: { click: function () { S.chain = c.id; S.group = null; S.q = ''; S.more = false; S.detail = null; renderSheet(sh); } } }, [el('span', { class: 'ic', text: c.ic }), el('b', { text: c.name })]);
      })));
      sh.appendChild(el('p', { class: 'lip-note', text: 'Official Australian menu numbers. Pork and bacon items aren\'t shown. Halal status varies by store, so check if it matters to you.' }));
      return;
    }
    var ch = EOD.chains.filter(function (c) { return c.id === S.chain; })[0];
    if (S.detail) { renderDetail(sh, ch, m); return; }
    sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: '‹ All places', on: { click: function () { S.chain = null; renderSheet(sh); } } }));
    sh.appendChild(el('p', { class: 'sub', text: ch.ic + ' ' + ch.name + ' instead of ' + m.name.toLowerCase() + ': ' + m.cal + ' kcal, ' + m.p + ' g protein. Tap one to log it.' }));

    var picks = bestPicks(ch, m);
    if (picks.length && !S.q && !S.group) {
      sh.appendChild(el('div', { class: 'lip-seclabel', text: 'Best picks for this meal' }));
      picks.forEach(function (x) { sh.appendChild(itemRow(x.it, ch, m, x.lite)); });
    }
    if (ch.hacks.length && !S.q && !S.group) {
      var hk = ch.hacks.slice(0, S.more ? ch.hacks.length : 4);
      sh.appendChild(el('div', { class: 'lip-seclabel', text: 'Order it smarter' }));
      sh.appendChild(el('div', { class: 'lip-tips' }, [el('ul', {}, hk.map(function (h) { return el('li', {}, [el('b', { text: h[0] }), h[1] ? el('small', { text: h[1] }) : null]); }))]));
      if (ch.hacks.length > 4 && !S.more) sh.appendChild(el('button', { type: 'button', class: 'lip-back', text: 'More tips', on: { click: function () { S.more = true; renderSheet(sh); } } }));
    }

    sh.appendChild(el('div', { class: 'lip-seclabel', text: 'Full menu' }));
    var search = el('input', { class: 'lip-in lip-search', type: 'search', placeholder: 'Search ' + ch.name + '…', 'aria-label': 'Search the menu', value: S.q });
    sh.appendChild(search);
    sh.appendChild(el('div', { class: 'lip-chips lip-groups' }, [el('button', { type: 'button', class: 'lip-chip' + (!S.group ? ' on' : ''), text: 'All', on: { click: function () { S.group = null; renderSheet(sh); } } })].concat(ch.g.map(function (g) {
      return el('button', { type: 'button', class: 'lip-chip' + (S.group === g.n ? ' on' : ''), text: g.n, on: { click: function () { S.group = g.n; renderSheet(sh); } } });
    }))));
    var list = el('div', { class: 'lip-list' });
    var fill = function () {
      list.innerHTML = '';
      var q = S.q.toLowerCase().trim(), n = 0;
      ch.g.forEach(function (g) {
        if (S.group && g.n !== S.group) return;
        var its = g.i.filter(function (it) { return !q || it[0].toLowerCase().indexOf(q) >= 0; });
        if (!its.length) return;
        if (!S.group) list.appendChild(el('div', { class: 'lip-gname', text: g.n }));
        its.forEach(function (it) { n++; list.appendChild(itemRow(it, ch, m)); });
      });
      if (!n) list.appendChild(el('p', { class: 'lip-line m', text: 'Nothing matches. Try another word.' }));
    };
    search.addEventListener('input', function () { S.q = search.value; fill(); });
    fill();
    sh.appendChild(list);
    if (ch.swaps.length) {
      sh.appendChild(el('details', { class: 'lip-swaps' }, [el('summary', { text: 'Has pork or bacon? Have this instead (' + ch.swaps.length + ')' }),
        el('ul', {}, ch.swaps.map(function (s) { return el('li', {}, [el('b', { text: s[0].replace(/\bMild\s+/g, '') }), el('small', { text: '→ ' + s[1] })]); }))]));
    }
    sh.appendChild(el('p', { class: 'lip-note', text: 'From ' + ch.src + '. Standard builds; extras and sauces change the numbers, and you can adjust before logging.' }));
  }
  /* Hands over to the page's own Swap form for that meal, pre-filled. The client still taps "Log swap" there. */
  function logOut(m, ch, v) {
    closeSheet();
    try { window.cv2Meal('swap', m.i); } catch (e) { return; }
    var tries = 0;
    (function fill() {
      var d = document.getElementById('sw-desc');
      if (!d || d.offsetParent === null) { if (++tries < 20) return setTimeout(fill, 60); return; }
      var set = function (id, x) { var n = document.getElementById(id); if (n) { n.value = String(x); try { n.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} } };
      try { var ex = document.getElementById('sw2-extra'); if (ex && ex.hidden && typeof window.sw2ToggleExtra === 'function') window.sw2ToggleExtra(); } catch (e) {}
      set('sw-desc', ch.name + ': ' + v.name); set('sw-cal', v.k); set('sw-p', v.p); set('sw-c', v.c); set('sw-f', v.f);
    })();
  }
  function openEatOut() { S = { meal: null, chain: null, group: null, q: '', more: false, detail: null }; var o1 = openMeals(); if (o1.length === 1) S.meal = o1[0]; loadMenus().catch(function () {}); sheet(renderSheet); }
  function renderEatOut() {
    try {
      var box = document.getElementById('cv2-nutri'); if (!box || document.getElementById('lip-eo')) return;
      var first = box.querySelector('.cv2-meal'); if (!first || !first.parentNode) return;
      var b = el('button', { type: 'button', class: 'lip-eo', id: 'lip-eo', on: { click: openEatOut } }, [
        el('span', { class: 'ic', text: '🍽️' }),
        el('span', {}, [el('b', { text: 'Eating out?' }), el('small', { text: 'GYG, KFC, Nando\'s, Oporto, Subway: picks that fit this meal' })]),
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
  window.LockedInPlus = { boot: boot, _t: { trendOf: trendOf, paceOf: paceOf, lastReps: lastReps, priorBest: priorBest, fitTag: fitTag, bestPicks: bestPicks, eatOut: function () { EAT_OUT_ON = true; renderEatOut(); } } };
})();
