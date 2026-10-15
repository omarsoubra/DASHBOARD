/* ==========================================================================
   LOCKED IN — in-app login setup (2026-10-15)
   --------------------------------------------------------------------------
   ONE shared file, loaded by push-client.js on every client page (so no page
   needs editing). On open, a client who is signed in on this phone and has no
   login yet is offered ONE sheet: choose an email + password. The server
   (api accountSelfSetup) decides; this file only asks.

   Rules this file keeps:
     * Identity is the phone's existing access key, sent only in POST bodies.
       The server refuses a key that appears in the public page (needs_invite);
       such a phone never sees the sheet again — Omar sends that client a link.
     * The password goes only to the api over HTTPS, never to storage, the
       console or the DOM outside its own input.
     * "Later" hides the sheet for 2 days; it comes back until the login exists.
     * Never stacks on the notifications sheet; never runs on the login page.
     * All dynamic text is set with textContent.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__liAccountSetup) return;
  window.__liAccountSetup = true;

  var SNOOZE_MS = 2 * 24 * 3600 * 1000;
  var API_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api$/;

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  function ctx() {
    try {
      var cfg = (typeof CLIENT_CONFIG !== 'undefined') ? CLIENT_CONFIG : null;
      var url = cfg && String(cfg.sheetsWebhookUrl || '');
      var key = cfg && cfg.client && cfg.client.storageKey;
      if (!key || !API_RE.test(url)) return null;
      var tok = (typeof CLIENT_TOKEN === 'string' && CLIENT_TOKEN) || localStorage.getItem(key + '_access_token') || '';
      return tok ? { key: key, url: url, token: tok } : null;
    } catch (e) { return null; }
  }
  function api(c, type, extra) {
    var body = { type: type, storageKey: c.key, token: c.token };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, cache: 'no-store', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); },
            function () { return { ok: false, error: 'network' }; });
  }
  var stateKey = function (c) { return 'li_account_setup_' + c.key; };
  function getState(c) { try { return JSON.parse(localStorage.getItem(stateKey(c)) || 'null') || {}; } catch (e) { return {}; } }
  function setState(c, s) { try { localStorage.setItem(stateKey(c), JSON.stringify(s)); } catch (e) {} }

  function injectStyle() {
    if (document.getElementById('lia-style')) return;
    var css =
      ':where(.lia-ask){position:fixed;inset:0;z-index:2147482999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55);padding:0 12px calc(12px + env(safe-area-inset-bottom));}' +
      ':where(.lia-card){width:100%;max-width:440px;background:var(--surface,#15161b);color:var(--text,inherit);border:1px solid var(--border,rgba(127,127,127,.25));border-radius:14px;padding:22px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.35);}' +
      ':where(.lia-icon){font-size:30px;line-height:1;margin-bottom:10px;}' +
      ':where(.lia-title){font-weight:700;font-size:19px;margin-bottom:6px;}' +
      ':where(.lia-text){margin:8px 0;font-size:14px;line-height:1.45;color:var(--muted,#8a8a92);}' +
      ':where(.lia-err){margin:8px 0;font-size:14px;color:var(--danger,#d64545);}' +
      ':where(.lia-label){display:block;font-size:13px;font-weight:600;margin:12px 0 4px;}' +
      ':where(.lia-input){display:block;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.35));background:var(--surface2,transparent);color:inherit;font:inherit;font-size:16px;}' +
      ':where(.lia-btn){display:block;width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:var(--accent,#6ea8ff);color:#fff;font:inherit;font-weight:600;cursor:pointer;}' +
      ':where(.lia-btn2){background:transparent;color:var(--text,inherit);border:1px solid var(--border,rgba(127,127,127,.35));margin-top:8px;}' +
      ':where(.lia-btn[disabled]){opacity:.6;}';
    var s = el('style', { id: 'lia-style' }); s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function explain(code) {
    switch (code) {
      case 'bad_email':          return 'That email doesn\'t look right. Check it and try again.';
      case 'password_too_short': return 'Use at least 8 characters for your password.';
      case 'password_too_long':  return 'That password is too long (72 characters max).';
      case 'password_too_weak':  return 'Choose a stronger password.';
      case 'email_in_use':       return 'That email already has a LOCKED IN login. Use a different email, or message Omar.';
      case 'network':            return 'No connection. Check your internet and try again.';
      default:                   return 'Something went wrong. Try again, or message Omar.';
    }
  }

  function show(c) {
    if (document.getElementById('lia-ask')) return;
    injectStyle();
    var wrap = el('div', { id: 'lia-ask', class: 'lia-ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lia-title' });
    var card = el('div', { class: 'lia-card' });
    wrap.appendChild(card);
    var close = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
    var form = el('form', { novalidate: 'novalidate' });
    var errBox = el('p', { class: 'lia-err', role: 'alert' });
    var email = el('input', { class: 'lia-input', type: 'email', id: 'lia-email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: 'required' });
    var pw = el('input', { class: 'lia-input', type: 'password', id: 'lia-password', autocomplete: 'new-password', minlength: '8', required: 'required' });
    var save = el('button', { type: 'submit', class: 'lia-btn' }, 'Save my login');
    var later = el('button', { type: 'button', class: 'lia-btn lia-btn2' }, 'Later');

    card.appendChild(el('div', { class: 'lia-icon', 'aria-hidden': 'true' }, '🔐'));
    card.appendChild(el('div', { class: 'lia-title', id: 'lia-title' }, 'Set up your login'));
    card.appendChild(el('p', { class: 'lia-text' }, 'Choose an email and password. You\'ll use them to sign in to LOCKED IN on a new phone. Takes 30 seconds.'));
    form.appendChild(el('label', { class: 'lia-label', for: 'lia-email' }, 'Email'));
    form.appendChild(email);
    form.appendChild(el('label', { class: 'lia-label', for: 'lia-password' }, 'Password (8+ characters)'));
    form.appendChild(pw);
    form.appendChild(errBox);
    form.appendChild(save);
    form.appendChild(later);
    card.appendChild(form);

    later.addEventListener('click', function () { setState(c, { snoozedAt: Date.now() }); close(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errBox.textContent = '';
      var em = String(email.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { errBox.textContent = explain('bad_email'); return; }
      if (String(pw.value || '').length < 8) { errBox.textContent = explain('password_too_short'); return; }
      save.setAttribute('disabled', 'disabled'); later.setAttribute('disabled', 'disabled'); save.textContent = 'Saving…';
      api(c, 'accountSelfSetup', { email: em, password: pw.value }).then(function (j) {
        if (j && j.ok) { setState(c, { done: true }); done(j.email || em); return; }
        var code = j && j.error;
        if (code === 'account_exists') { setState(c, { done: true }); close(); return; }
        if (code === 'needs_invite') { setState(c, { needsInvite: true }); close(); return; }
        errBox.textContent = explain(code);
        save.removeAttribute('disabled'); later.removeAttribute('disabled'); save.textContent = 'Save my login';
      });
    });
    function done(em) {
      pw.value = '';
      while (card.firstChild) card.removeChild(card.firstChild);
      card.appendChild(el('div', { class: 'lia-icon', 'aria-hidden': 'true' }, '✅'));
      card.appendChild(el('div', { class: 'lia-title', id: 'lia-title' }, 'You\'re all set'));
      card.appendChild(el('p', { class: 'lia-text' }, 'Your login is ' + em + '. Nothing changes on this phone. On a new phone, open LOCKED IN and sign in with this email and password.'));
      var ok = el('button', { type: 'button', class: 'lia-btn' }, 'Done');
      ok.addEventListener('click', close);
      card.appendChild(ok);
    }
    document.body.appendChild(wrap);
  }

  function boot() {
    if (/\/login\//.test(location.pathname)) return;
    var c = ctx();
    if (!c) return;
    var s = getState(c);
    if (s.done || s.needsInvite) return;
    if (s.snoozedAt && Date.now() - s.snoozedAt < SNOOZE_MS) return;
    api(c, 'accountSelfStatus', {}).then(function (j) {
      if (!j || !j.ok) return;
      if (j.account === 'active') { setState(c, { done: true }); return; }
      if (!j.canSetup) { setState(c, { needsInvite: true }); return; }
      // Never on top of the notifications sheet: wait until it is answered.
      var tries = 0;
      (function wait() {
        if (document.getElementById('lip-ask') && tries++ < 240) { setTimeout(wait, 500); return; }
        show(c);
      })();
    });
  }
  var start = function () { setTimeout(boot, 2500); };   // after the shell's own boot + the notifications check
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
