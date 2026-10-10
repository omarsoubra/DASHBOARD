/* ==========================================================================
   LOCKED IN Push Notifications — client opt-in + settings (V1)
   --------------------------------------------------------------------------
   ONE shared file for every client shell. A shell includes it and calls:

     LockedInPush.mount({
       container:  <element>,
       storageKey: '<client storage key>',
       getToken:   () => '<client access token>',   // read at call time, never stored here
       pushUrl:    'https://<ref>.supabase.co/functions/v1/push',
       swUrl:      '../../sw.js',                    // root worker, scoped to the shell's folder
       compact:    true,                             // optional: collapsed one-line summary until tapped
     });

   Deep links (daily reminders V1): a notification may open ./?li=training or
   ./?li=nutrition. This file routes that to the shell's own showSection() —
   on a cold start after the shell has booted, and for an already-open app via
   a message from sw.js. Unknown values, or a shell without showSection, leave
   the app on its home page. No new page routes exist.

   Rules this file keeps:
     * Notification permission is requested ONLY inside the "Turn on" tap
       handler (_onEnable). Never on load, never on a timer, never repeatedly.
     * ONE TAP (2026-10-11): for a client the server marks oneTap (plan-synced
       rollout), the app offers ONE sheet on open: "Turn on reminders" / "Not
       now". The sheet itself asks nothing of the OS; its button is the tap that
       calls _onEnable, and the server switches every reminder on at that first
       opt-in. Shown only where a push can actually arrive (Home Screen app on
       iPhone), only while permission is still undecided, at most twice ever per
       phone ("Not now" → once more after 7 days, then never).
     * No secret lives here. The VAPID public key is fetched from the server.
     * The client token goes only into POST bodies to pushUrl — never a URL,
       never the console, never the DOM.
     * All dynamic text is set with textContent.
     * Styling inherits the host page (CSS variables, fonts); base rules use
       :where() so the page's own styles always win.
   ========================================================================== */
(function () {
  'use strict';

  var UA = (navigator.userAgent || '');
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /Android/i.test(UA);
  var DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }

  // ── deep links: ?li=<section> → the shell's existing section switcher ──────
  var LI_SECTIONS = ['training', 'nutrition'];
  function liRoute(section) {
    if (LI_SECTIONS.indexOf(section) < 0) return false;            // invalid → stay on home
    try {
      if (typeof window.showSection !== 'function' || !document.getElementById('section-' + section)) return false;
      window.showSection(section);
      return true;
    } catch (e) { return false; }
  }
  (function liBoot() {
    var section = null;
    try {
      var params = new URLSearchParams(window.location.search);
      section = params.get('li');
      if (section !== null) {                                       // always clean the URL, valid or not
        params.delete('li');
        var qs = params.toString();
        history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      }
    } catch (e) {}
    // After the shell's own boot (which shows home), so the section sticks.
    var go = function () { setTimeout(function () { liRoute(section); }, 150); };
    if (section !== null) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    }
    // Already-open app: sw.js focuses this window and names the section.
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function (e) {
          var d = e && e.data;
          if (d && d.type === 'li-open' && typeof d.section === 'string') liRoute(d.section);
        });
      }
    } catch (e) {}
  })();

  function supportsPush() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  function b64urlToBytes(s) {
    var pad = '='.repeat((4 - (s.length % 4)) % 4);
    var b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function localTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function label12(hhmm) {
    var p = hhmm.split(':'), h = +p[0], m = p[1];
    return ((h % 12) || 12) + ':' + m + (h < 12 ? ' AM' : ' PM');
  }

  var TIMES = (function () {
    var out = [];
    for (var m = 0; m < 1440; m += 15) out.push(('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2));
    return out;
  })();

  function injectStyle() {
    if (document.getElementById('lip-style')) return;
    var css =
      ':where(.lip-card){background:var(--surface,#15161b);border:1px solid var(--border,rgba(127,127,127,.25));border-radius:14px;padding:16px;margin:16px 0;color:var(--text,inherit);}' +
      ':where(.lip-title){font-weight:700;font-size:16px;margin-bottom:6px;}' +
      ':where(.lip-text,.lip-muted,.lip-ok,.lip-err){margin:8px 0;font-size:14px;line-height:1.45;}' +
      ':where(.lip-muted){color:var(--muted,#8a8a92);font-size:13px;}' +
      ':where(.lip-ok){color:var(--accent3,#2e9e5b);}' +
      ':where(.lip-err){color:var(--danger,#d64545);}' +
      ':where(.lip-steps){margin:8px 0;padding-left:20px;font-size:14px;} :where(.lip-steps li){margin:4px 0;}' +
      ':where(.lip-btn){display:block;width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:var(--accent,#6ea8ff);color:#fff;font:inherit;font-weight:600;cursor:pointer;}' +
      ':where(.lip-btn2){background:transparent;color:var(--text,inherit);border:1px solid var(--border,rgba(127,127,127,.35));}' +
      ':where(.lip-btn[disabled]){opacity:.6;}' +
      ':where(.lip-head){display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;background:none;border:0;padding:0;width:100%;color:inherit;font:inherit;text-align:left;}' +
      ':where(.lip-pill){font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.35));color:var(--muted,#8a8a92);white-space:nowrap;}' +
      ':where(.lip-pill.on){color:var(--accent3,#2e9e5b);border-color:currentColor;}' +
      ':where(.lip-row){display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid var(--border,rgba(127,127,127,.2));font-size:14px;}' +
      ':where(.lip-row .lip-sub){display:block;color:var(--muted,#8a8a92);font-size:12px;margin-top:2px;}' +
      ':where(.lip-ctrl){display:flex;align-items:center;gap:6px;flex-shrink:0;}' +
      ':where(.lip-sel){font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,rgba(127,127,127,.35));background:var(--surface2,transparent);color:inherit;max-width:110px;}' +
      ':where(.lip-switch){position:relative;width:44px;height:26px;border-radius:13px;border:0;background:var(--border,rgba(127,127,127,.35));cursor:pointer;flex-shrink:0;padding:0;}' +
      ':where(.lip-switch)::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s;}' +
      ':where(.lip-switch[aria-checked="true"]){background:var(--accent,#6ea8ff);}' +
      ':where(.lip-switch[aria-checked="true"])::after{transform:translateX(18px);}' +
      ':where(.lip-switch[disabled]){opacity:.5;}' +
      ':where(.lip-ask){position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55);padding:0 12px calc(12px + env(safe-area-inset-bottom));}' +
      ':where(.lip-ask .lip-card){width:100%;max-width:440px;margin:0;padding:22px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.35);}' +
      ':where(.lip-ask .lip-bell){font-size:30px;line-height:1;margin-bottom:10px;}' +
      ':where(.lip-ask .lip-title){font-size:19px;}' +
      ':where(.lip-ask .lip-later){margin-top:6px;}';
    var s = el('style', { id: 'lip-style' }); s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function Push(opts) {
    this.o = opts;
    this.reg = null;
    this.vapidKey = null;
    this.serverRegistered = false;
    this.prefs = null;
    this.busy = false;
    this.saving = false;
    this.lastError = '';
    this.open = !opts.compact;
    this.oneTap = false;
    this.asked = false;
  }

  Push.prototype.api = function (type, extra) {
    var body = { type: type, storageKey: this.o.storageKey, token: this.o.getToken() };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    return fetch(this.o.pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // simple request: no CORS preflight
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad_response' }; });
    }, function () {
      return { ok: false, error: 'network' };
    });
  };

  // ── boot: register the worker + read state. No permission prompt here. ────
  Push.prototype.init = function () {
    var self = this;
    if (!supportsPush()) { self.render(); return Promise.resolve(); }
    if (!self.o.getToken()) { self.lastError = 'This device is not linked yet.'; self.render(); return Promise.resolve(); }
    return navigator.serviceWorker.register(self.o.swUrl, { scope: './' })
      .then(function (reg) { self.reg = reg; return navigator.serviceWorker.ready; })
      .then(function () { return self.reg.pushManager.getSubscription(); })
      .then(function (sub) {
        return self.api('pushStatus', { endpoint: sub ? sub.endpoint : '' }).then(function (j) {
          if (!j || j.ok !== true) { self.lastError = self.explain(j && j.error); return; }
          self.vapidKey = j.vapidPublicKey || null;
          self.oneTap = j.oneTap === true;
          self.serverRegistered = !!(sub && j.registered);
          if (self.serverRegistered) return self.loadPrefs();
        });
      })
      .catch(function () { self.lastError = 'Could not start notifications on this device.'; })
      .then(function () { self.render(); self._maybeAsk(); });
  };

  // ── ONE TAP: the single on-open offer ──────────────────────────────────────
  var ASK_AGAIN_MS = 7 * 24 * 3600 * 1000;
  Push.prototype._askKey = function () { return 'li_push_ask_' + this.o.storageKey; };
  Push.prototype._askState = function () {
    try { var s = JSON.parse(localStorage.getItem(this._askKey()) || 'null'); if (s && typeof s.n === 'number') return s; } catch (e) {}
    return { n: 0, at: 0 };
  };
  Push.prototype._askSave = function (s) {
    try { localStorage.setItem(this._askKey(), JSON.stringify(s)); } catch (e) {}
  };
  Push.prototype._shouldAsk = function () {
    if (!this.oneTap || this.serverRegistered || !this.reg || !this.vapidKey) return false;
    if (!supportsPush() || (IS_IOS && !isStandalone())) return false;          // no push can arrive here
    if (Notification.permission !== 'default') return false;                    // already decided at OS level
    var s = this._askState();
    return s.n === 0 || (s.n === 1 && Date.now() - s.at >= ASK_AGAIN_MS);
  };
  Push.prototype._maybeAsk = function () {
    var self = this;
    if (self.asked || !self._shouldAsk()) return;
    self.asked = true;                                                          // at most once per app open
    // Read what the plan offers (works before opt-in), then let the app paint first.
    self.loadPrefs().then(function () {
      setTimeout(function () { if (self._shouldAsk()) self._showAsk(); }, 900);
    });
  };
  // Name only what this client's plan actually schedules today (server truth, never assumed).
  Push.prototype._askWhat = function () {
    var d = (this.prefs && this.prefs.daily) || {};
    if (d.trainingAvailable && d.mealsAvailable) return { title: 'Get reminders for your workouts and meals?', when: 'at your planned training and meal times, plus check-in day' };
    if (d.trainingAvailable) return { title: 'Get reminders for your workouts?', when: 'at your planned training times, plus check-in day' };
    if (d.mealsAvailable) return { title: 'Get reminders for your meals?', when: 'at your planned meal times, plus check-in day' };
    return { title: 'Get reminders?', when: 'on check-in day and when Omar updates your program' };
  };
  Push.prototype._showAsk = function () {
    var self = this;
    if (document.getElementById('lip-ask')) return;
    injectStyle();
    var wrap = el('div', { id: 'lip-ask', class: 'lip-ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lip-ask-title' });
    var card = el('div', { class: 'lip-card' });
    wrap.appendChild(card);
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    function paint(state) {
      while (card.firstChild) card.removeChild(card.firstChild);
      card.appendChild(el('div', { class: 'lip-bell', 'aria-hidden': 'true' }, state === 'done' ? '✅' : '🔔'));
      if (state === 'done') {
        card.appendChild(el('div', { class: 'lip-title', id: 'lip-ask-title' }, 'Reminders are on'));
        card.appendChild(el('p', { class: 'lip-text' }, 'You\'ll get them ' + self._askWhat().when + '. Change them anytime under Notifications.'));
        var ok = el('button', { type: 'button', class: 'lip-btn' }, 'Done');
        ok.addEventListener('click', close);
        card.appendChild(ok);
        return;
      }
      var w = self._askWhat();
      card.appendChild(el('div', { class: 'lip-title', id: 'lip-ask-title' }, w.title));
      card.appendChild(el('p', { class: 'lip-text' }, 'We\'ll remind you ' + w.when + '. You can change this anytime.'));
      if (state === 'error' && self.lastError) card.appendChild(el('p', { class: 'lip-err' }, self.lastError));
      var on = el('button', { type: 'button', class: 'lip-btn' }, state === 'busy' ? 'Turning on…' : 'Turn on reminders');
      var later = el('button', { type: 'button', class: 'lip-btn lip-btn2 lip-later' }, 'Not now');
      if (state === 'busy') { on.setAttribute('disabled', 'disabled'); later.setAttribute('disabled', 'disabled'); }
      on.addEventListener('click', function () {
        self._askSave({ n: 9, at: Date.now() });                                // answered: never offer again
        paint('busy');
        // _onEnable asks the OS for permission first thing, inside this same tap.
        var p = self._onEnable();
        (p && p.then ? p : Promise.resolve()).then(function () {
          if (self.serverRegistered) paint('done');
          else if (('Notification' in window) && Notification.permission === 'denied') close();
          else paint('error');
        });
      });
      later.addEventListener('click', function () {
        var s = self._askState();
        self._askSave({ n: s.n + 1, at: Date.now() });
        close();
      });
      card.appendChild(on);
      card.appendChild(later);
    }
    paint('ask');
    document.body.appendChild(wrap);
  };

  Push.prototype.loadPrefs = function () {
    var self = this;
    return self.api('pushPrefsGet', {}).then(function (j) { if (j && j.ok) self.prefs = j.prefs; });
  };

  Push.prototype.explain = function (code) {
    switch (code) {
      case 'push_not_enabled':    return 'Notifications are not switched on for this account yet.';
      case 'push_not_configured': return 'Notifications are not configured on the server yet.';
      case 'bad_token': case 'unknown_client': case 'missing_credentials':
                                  return 'This device is not linked to your account. Re-open your personal link.';
      case 'access_revoked': case 'access_suspended':
                                  return 'Your access is paused. Message Omar.';
      case 'endpoint_host_not_allowed': return 'This browser uses a push service LOCKED IN does not accept.';
      case 'network':             return 'No connection. Check your internet and try again.';
      default:                    return 'Something went wrong (' + String(code || 'unknown').slice(0, 40) + ').';
    }
  };

  // ── Turn on: the ONLY place permission is requested (direct user gesture) ──
  Push.prototype._onEnable = function () {
    var self = this;
    if (self.busy) return;
    if (!self.reg || !self.vapidKey) { self.lastError = 'Not ready yet. Close and reopen the app.'; self.render(); return; }
    self.busy = true; self.lastError = ''; self.render();
    // The permission prompt is the first await inside the tap — iOS requires this.
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw { user: true };
      return self.reg.pushManager.getSubscription().then(function (existing) {
        return existing || self.reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToBytes(self.vapidKey),
        });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return self.api('pushSubscribe', {
        subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth } },
        timezone: localTimezone(),
        standalone: isStandalone(),
      }).then(function (res) {
        if (res && res.ok === true) { self.serverRegistered = true; self.open = true; return self.loadPrefs(); }
        // Server refused: do not leave a browser subscription nobody can use.
        self.lastError = self.explain(res && res.error);
        return sub.unsubscribe().catch(function () {});
      });
    }).catch(function (e) {
      if (!(e && e.user)) self.lastError = 'Could not turn on notifications on this device.';
    }).then(function () { self.busy = false; self.render(); });
  };

  // ── Turn off: settings off + server revoke (needs the endpoint), then browser ─
  Push.prototype._onDisable = function () {
    var self = this;
    if (self.busy || !self.reg) return;
    self.busy = true; self.lastError = ''; self.render();
    self.api('pushPrefsSet', { prefs: { notificationsEnabled: false } }).then(function () {
      return self.reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return;
      return self.api('pushUnsubscribe', { endpoint: sub.endpoint }).then(function (res) {
        if (!res || res.ok !== true) self.lastError = 'Turned off on this phone; the server will clean up on the next send.';
        return sub.unsubscribe().catch(function () {});
      });
    }).catch(function () {
      self.lastError = 'Could not turn off notifications.';
    }).then(function () { self.serverRegistered = false; self.prefs = null; self.busy = false; self.render(); });
  };

  // ── settings: one field per request, optimistic with rollback ──────────────
  Push.prototype._save = function (field, value) {
    var self = this;
    if (self.saving || !self.prefs) return;
    var before = self.prefs[field];
    self.prefs[field] = value; self.saving = true; self.lastError = ''; self.render();
    var patch = {}; patch[field] = value;
    self.api('pushPrefsSet', { prefs: patch }).then(function (j) {
      if (j && j.ok && j.prefs) self.prefs = j.prefs;
      else { self.prefs[field] = before; self.lastError = self.saveError(j && j.error); }
    }).then(function () { self.saving = false; self.render(); });
  };

  Push.prototype.saveError = function (code) {
    switch (code) {
      case 'training_not_available': case 'meals_not_available': case 'daily_not_available':
                                           return 'That reminder isn\'t available for your current plan.';
      case 'network':                      return 'No connection. Check your internet and try again.';
      default:                             return 'Could not save that change. Try again.';
    }
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  Push.prototype.render = function () {
    var self = this;
    var c = self.o.container;
    if (!c) return;
    injectStyle();
    while (c.firstChild) c.removeChild(c.firstChild);
    var card = el('div', { class: 'lip-card' });
    // "On" only when this very context can receive pushes — never in an iPhone
    // Safari tab, where the body shows Home Screen guidance instead.
    var on = self.serverRegistered && supportsPush() && !(IS_IOS && !isStandalone()) &&
             Notification.permission === 'granted';

    if (self.o.compact) {
      var head = el('button', { type: 'button', class: 'lip-head', 'aria-expanded': String(self.open) });
      head.appendChild(el('span', { class: 'lip-title' }, 'Notifications'));
      head.appendChild(el('span', { class: 'lip-pill' + (on ? ' on' : '') }, on ? 'On' : 'Off'));
      head.addEventListener('click', function () { self.open = !self.open; self.render(); });
      card.appendChild(head);
      if (!self.open) { c.appendChild(card); self._emit(); return; }
    } else {
      card.appendChild(el('div', { class: 'lip-title' }, 'Notifications'));
    }

    function para(t, cls) { card.appendChild(el('p', { class: cls || 'lip-text' }, t)); }
    function steps(list) {
      var ol = el('ol', { class: 'lip-steps' });
      list.forEach(function (s) { ol.appendChild(el('li', null, s)); });
      card.appendChild(ol);
    }
    function button(label, handler, secondary) {
      var b = el('button', { type: 'button', class: secondary ? 'lip-btn lip-btn2' : 'lip-btn' }, label);
      if (self.busy) b.setAttribute('disabled', 'disabled');
      b.addEventListener('click', handler);
      card.appendChild(b);
    }

    if (IS_IOS && !isStandalone()) {
      para('On iPhone, notifications only work from the LOCKED IN app on your Home Screen.');
      steps([
        'Open this page in Safari (if you came from WhatsApp, tap the Safari/compass icon or "Open in Safari").',
        'Tap the Share button (square with the arrow).',
        'Tap "Add to Home Screen", then "Add".',
        'Open LOCKED IN from your Home Screen and turn notifications on there.',
      ]);
      para('Needs iOS 16.4 or later.', 'lip-muted');
    } else if (!supportsPush()) {
      para(IS_IOS
        ? 'This iPhone cannot receive notifications from web apps. Update to iOS 16.4 or later.'
        : 'This browser does not support notifications.');
    } else if (Notification.permission === 'denied') {
      para('Notifications are blocked for LOCKED IN on this device.');
      steps(IS_IOS
        ? ['Open iPhone Settings → Notifications.', 'Find LOCKED IN and switch on "Allow Notifications".', 'Come back here and reopen the app.']
        : ['Open your browser site settings for this page.', 'Allow notifications.', 'Reload this page.']);
    } else if (on) {
      para('Notifications are on for this device.', 'lip-ok');
      if (self.prefs) self._settings(card); else para('Loading your settings…', 'lip-muted');
      button(self.busy ? 'Working…' : 'Turn off notifications', function () { self._onDisable(); }, true);
    } else {
      para('Reminders for your check-in and a heads-up when Omar updates your program. You can turn this off at any time.');
      button(self.busy ? 'Working…' : 'Turn on notifications', function () { self._onEnable(); });
    }

    if (self.lastError) para(self.lastError, 'lip-err');
    c.appendChild(card);
    self._emit();
  };

  Push.prototype._settings = function (card) {
    var self = this, p = self.prefs;
    function row(title, sub, controls) {
      var r = el('div', { class: 'lip-row' });
      var left = el('div'); left.appendChild(el('span', null, title));
      if (sub) left.appendChild(el('span', { class: 'lip-sub' }, sub));
      var right = el('div', { class: 'lip-ctrl' });
      controls.forEach(function (x) { right.appendChild(x); });
      r.appendChild(left); r.appendChild(right); card.appendChild(r);
    }
    function sw(field, labelText) {
      var b = el('button', { type: 'button', role: 'switch', class: 'lip-switch', 'aria-checked': String(!!p[field]), 'aria-label': labelText });
      if (self.saving) b.setAttribute('disabled', 'disabled');
      b.addEventListener('click', function () { self._save(field, !p[field]); });
      return b;
    }
    function sel(field, labelText) {
      var s = el('select', { class: 'lip-sel', 'aria-label': labelText });
      TIMES.forEach(function (t) { var o = el('option', { value: t }, label12(t)); if (t === p[field]) o.selected = true; s.appendChild(o); });
      if (self.saving) s.setAttribute('disabled', 'disabled');
      s.addEventListener('change', function () { self._save(field, s.value); });
      return s;
    }
    if (p.weighinAvailable) {
      row('Morning weigh-in', 'Only if you haven\'t logged today', p.weighinEnabled ? [sel('weighinTime', 'Weigh-in reminder time'), sw('weighinEnabled', 'Morning weigh-in reminder')] : [sw('weighinEnabled', 'Morning weigh-in reminder')]);
    }
    row('Weekly check-in', (DAYS[p.checkinDow] || 'Sundays') + ', only if it isn\'t done', p.checkinEnabled ? [sel('checkinTime', 'Check-in reminder time'), sw('checkinEnabled', 'Weekly check-in reminder')] : [sw('checkinEnabled', 'Weekly check-in reminder')]);
    row('Program updates', 'When Omar updates your program', [sw('programUpdatesEnabled', 'Program update notifications')]);
    if (p.daily && p.daily.available) self._daily(row, sw);
    row('Quiet hours', 'Nothing is sent in this window', [sel('quietStart', 'Quiet hours start'), el('span', { class: 'lip-muted' }, '–'), sel('quietEnd', 'Quiet hours end')]);
    var tz = localTimezone();
    if (tz && p.timezone !== tz) {
      var fix = el('button', { type: 'button', class: 'lip-sel' }, 'Use ' + tz);
      fix.addEventListener('click', function () { self._save('timezone', tz); });
      row('Timezone', p.timezone || 'Not set', [fix]);
    } else {
      card.appendChild(el('p', { class: 'lip-muted' }, 'Times are in ' + (p.timezone || 'your timezone') + '.'));
    }
  };

  // ── Plan-synced reminders: the approved plan owns days and times; the client
  //    only chooses ON/OFF. A row exists only when the server has a confirmed,
  //    verified-live schedule for that category — otherwise it is not shown at all.
  Push.prototype._daily = function (row, sw) {
    var d = this.prefs.daily;
    if (d.trainingAvailable) row('Training reminders', 'Synced with your training plan', [sw('trainingEnabled', 'Training reminders')]);
    if (d.mealsAvailable) row('Meal reminders', 'Synced with your meal plan', [sw('mealsEnabled', 'Meal reminders')]);
  };

  Push.prototype._emit = function () {
    if (typeof this.o.onState === 'function') {
      try { this.o.onState(this.diagnostics()); } catch (e) {}
    }
  };

  // Non-secret state, for the canary's diagnostic panel.
  Push.prototype.diagnostics = function () {
    return {
      platform: IS_IOS ? 'ios' : IS_ANDROID ? 'android' : 'other',
      standalone: isStandalone(),
      pushSupported: supportsPush(),
      permission: ('Notification' in window) ? Notification.permission : 'unsupported',
      workerScope: this.reg ? this.reg.scope : null,
      serverKnown: !!this.vapidKey,
      registeredOnServer: this.serverRegistered,
      timezone: localTimezone(),
    };
  };

  window.LockedInPush = {
    mount: function (opts) {
      var p = new Push(opts);
      p.render();
      p.init();
      return p;
    },
  };
})();
