/* ==========================================================================
   LOCKED IN Push Notifications — client opt-in (minimal proof)
   --------------------------------------------------------------------------
   ONE shared file for every client shell. A shell includes it and calls:

     LockedInPush.mount({
       container:  <element>,
       storageKey: '<client storage key>',
       getToken:   () => '<client access token>',   // read at call time, never stored here
       pushUrl:    'https://<ref>.supabase.co/functions/v1/push',
       swUrl:      '../../sw.js',                    // root worker, scoped to the shell's folder
     });

   Rules this file keeps:
     * Notification permission is requested ONLY inside the "Turn on" tap
       handler (_onEnable). Never on load, never on a timer.
     * No secret lives here. The VAPID public key is fetched from the server.
     * The client token goes only into POST bodies to pushUrl — never a URL,
       never the console, never the DOM.
     * All dynamic text is set with textContent.
   ========================================================================== */
(function () {
  'use strict';

  var UA = (navigator.userAgent || '');
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /Android/i.test(UA);

  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }

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

  function Push(opts) {
    this.o = opts;
    this.reg = null;
    this.vapidKey = null;
    this.serverRegistered = false;
    this.busy = false;
    this.lastError = '';
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
          self.serverRegistered = !!(sub && j.registered);
        });
      })
      .catch(function () { self.lastError = 'Could not start notifications on this device.'; })
      .then(function () { self.render(); });
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
    Notification.requestPermission().then(function (perm) {
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
        if (res && res.ok === true) { self.serverRegistered = true; return; }
        // Server refused: do not leave a browser subscription nobody can use.
        self.lastError = self.explain(res && res.error);
        return sub.unsubscribe().catch(function () {});
      });
    }).catch(function (e) {
      if (!(e && e.user)) self.lastError = 'Could not turn on notifications on this device.';
    }).then(function () { self.busy = false; self.render(); });
  };

  // ── Turn off: server revoke first (needs the endpoint), then browser ───────
  Push.prototype._onDisable = function () {
    var self = this;
    if (self.busy || !self.reg) return;
    self.busy = true; self.lastError = ''; self.render();
    self.reg.pushManager.getSubscription().then(function (sub) {
      if (!sub) return;
      return self.api('pushUnsubscribe', { endpoint: sub.endpoint }).then(function (res) {
        if (!res || res.ok !== true) self.lastError = 'Turned off on this phone; the server will clean up on the next send.';
        return sub.unsubscribe().catch(function () {});
      });
    }).catch(function () {
      self.lastError = 'Could not turn off notifications.';
    }).then(function () { self.serverRegistered = false; self.busy = false; self.render(); });
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  Push.prototype.render = function () {
    var self = this;
    var c = self.o.container;
    while (c.firstChild) c.removeChild(c.firstChild);
    var card = el('div', { class: 'lip-card' });
    card.appendChild(el('div', { class: 'lip-title' }, 'Notifications'));

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
    } else if (self.serverRegistered && Notification.permission === 'granted') {
      para('Notifications are on for this device.', 'lip-ok');
      button(self.busy ? 'Working…' : 'Turn off notifications', function () { self._onDisable(); }, true);
    } else {
      para('Get a notification when Omar sends you something. You can turn this off at any time.');
      button(self.busy ? 'Working…' : 'Turn on notifications', function () { self._onEnable(); });
    }

    if (self.lastError) para(self.lastError, 'lip-err');
    c.appendChild(card);
    if (typeof self.o.onState === 'function') {
      try { self.o.onState(self.diagnostics()); } catch (e) {}
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
