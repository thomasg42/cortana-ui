// CORE LINK login gate. Blocks the app behind a full-screen overlay until a
// valid session cookie exists, then hands off to the caller's boot function.
// Design: brainstorms/cortana-biometric-auth.md.
(function () {
  'use strict';

  const SESSION_TOKEN_KEY = 'cortana-core-session-token-v1';
  let sessionToken = '';
  try { sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY) || ''; } catch (_) {}
  function rememberSession(data) {
    const token = data && typeof data.sessionToken === 'string' ? data.sessionToken : '';
    if (!token) return;
    sessionToken = token;
    try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch (_) {}
  }
  function clearRememberedSession() {
    sessionToken = '';
    try { sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch (_) {}
  }
  window.CortanaAuth = {
    getToken: () => sessionToken,
    clearToken: clearRememberedSession,
  };

  // fetcher/base are injected per call site: on the github.io static deploy
  // this must be {fetchImpl: realFetch, base: remoteCore} to bypass the
  // window.fetch monkey-patch in index.html (which itself calls
  // ensureRemoteSession() and would deadlock if the auth gate's own network
  // calls went through it while a connect is already in flight). On
  // localhost, plain window.fetch + relative paths (the default) is correct.
  let activeFetch = window.fetch.bind(window);
  let activeBase = '';
  /* Once a caller has pinned a remote core, a later call that omits `base`
     must NOT drag the gate back to relative paths through the patched
     window.fetch — that routes the gate's own login requests into
     ensureRemoteSession(), which is already awaiting this very gate, and both
     sides hang. index.html's DOMContentLoaded handler used to do exactly
     that, which is how tapping Unlock could end up doing nothing at all. */
  let transportPinned = false;
  function apiUrl(path) { return activeBase + path; }
  function applyTransport(opts) {
    const base = opts && typeof opts.base === 'string' ? opts.base : '';
    if (base) {
      activeBase = base;
      activeFetch = (opts && opts.fetchImpl) || window.fetch.bind(window);
      transportPinned = true;
    } else if (!transportPinned) {
      activeBase = '';
      activeFetch = (opts && opts.fetchImpl) || window.fetch.bind(window);
    }
  }

  function b64urlToBuffer(b64url) {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const str = atob(b64);
    const buf = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    return buf.buffer;
  }
  function bufferToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function credentialCreationOptionsFromJSON(json) {
    return Object.assign({}, json, {
      challenge: b64urlToBuffer(json.challenge),
      user: Object.assign({}, json.user, { id: b64urlToBuffer(json.user.id) }),
      excludeCredentials: (json.excludeCredentials || []).map((c) => Object.assign({}, c, { id: b64urlToBuffer(c.id) })),
    });
  }
  function credentialRequestOptionsFromJSON(json) {
    return Object.assign({}, json, {
      challenge: b64urlToBuffer(json.challenge),
      allowCredentials: (json.allowCredentials || []).map((c) => Object.assign({}, c, { id: b64urlToBuffer(c.id) })),
    });
  }
  function registrationResponseToJSON(cred) {
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
        attestationObject: bufferToB64url(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }
  function authenticationResponseToJSON(cred) {
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
        authenticatorData: bufferToB64url(cred.response.authenticatorData),
        signature: bufferToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufferToB64url(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  async function api(path, opts) {
    const headers = new Headers((opts && opts.headers) || {});
    if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
    const res = await activeFetch(apiUrl(path), Object.assign({ credentials: 'include' }, opts, { headers }));
    let data = {};
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (res.status === 401 && sessionToken) clearRememberedSession();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function apiPost(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function detectDeviceType() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return 'phone';
    if (/Macintosh|Windows|Linux/i.test(ua)) return 'laptop';
    return 'other';
  }
  function platformLabel(type) {
    if (type === 'phone') return 'Face ID';
    if (type === 'laptop') return 'Touch ID';
    return 'this device';
  }

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'authGate';
    el.innerHTML = `
      <style>
        #authGate { position: fixed; inset: 0; z-index: 999999; display: flex; align-items: center; justify-content: center;
          background: radial-gradient(1200px 800px at 50% 20%, rgba(4,14,13,.98), rgba(1,5,5,.99) 70%);
          font-family: 'Segoe UI', -apple-system, sans-serif; color: rgba(210,255,244,.92); }
        #authGate.hidden { display: none; }
        #authGate .card { width: min(92vw, 380px); border: 1px solid rgba(120,231,208,.32); border-radius: 10px;
          background: rgba(3,10,9,.88); padding: 28px 26px 24px; box-shadow: 0 0 40px rgba(120,231,208,.08); }
        #authGate h1 { margin: 0 0 4px; font-size: 15px; letter-spacing: .12em; text-transform: uppercase;
          color: rgba(255,214,109,.86); text-shadow: 0 0 16px rgba(255,196,46,.25); }
        #authGate p.sub { margin: 0 0 20px; font-size: 12px; color: rgba(160,220,210,.62); }
        #authGate button { width: 100%; margin-bottom: 10px; padding: 12px 14px; border-radius: 6px;
          border: 1px solid rgba(120,231,208,.34); background: rgba(120,231,208,.08); color: rgba(210,255,244,.92);
          font-size: 13px; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
        #authGate button:hover { background: rgba(120,231,208,.16); border-color: rgba(120,231,208,.55); }
        #authGate button.primary { border-color: rgba(255,196,46,.5); background: rgba(255,196,46,.10); }
        #authGate button.primary:hover { background: rgba(255,196,46,.18); }
        #authGate button:disabled { opacity: .45; cursor: default; }
        #authGate input[type=text] { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 11px 12px;
          border-radius: 6px; border: 1px solid rgba(120,231,208,.34); background: rgba(0,0,0,.35);
          color: rgba(210,255,244,.95); font-size: 16px; letter-spacing: .2em; text-align: center; }
        #authGate .msg { min-height: 16px; font-size: 12px; margin-bottom: 12px; color: rgba(255,150,150,.85); }
        #authGate .msg.ok { color: rgba(160,240,190,.85); }
        #authGate .link { background: none; border: none; color: rgba(160,220,210,.7); font-size: 11px;
          text-decoration: underline; cursor: pointer; padding: 4px 0; width: auto; margin: 0; }
        #authGate .divider { border-top: 1px solid rgba(120,231,208,.18); margin: 14px 0; }
      </style>
      <div class="card">
        <h1>Core Link — Locked</h1>
        <p class="sub" id="authGateSub">Unlock to give Cortana full tool access.</p>
        <div id="authGateBody"></div>
        <div class="msg" id="authGateMsg"></div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  function renderChoice(gate, refs) {
    const type = detectDeviceType();
    refs.body.innerHTML = '';
    // Warm a challenge now, while nothing is blocking, so the tap handler can
    // reach navigator.credentials.get() without an await in front of it.
    prefetchLoginOptions(false);
    const biometricBtn = document.createElement('button');
    biometricBtn.className = 'primary';
    biometricBtn.textContent = `Unlock with ${platformLabel(type)}`;
    biometricBtn.onclick = () => loginWithPasskey(gate, refs);
    refs.body.appendChild(biometricBtn);

    const emailBtn = document.createElement('button');
    emailBtn.textContent = 'Email me a code instead';
    emailBtn.onclick = () => renderOtpRequest(gate, refs, 'login');
    refs.body.appendChild(emailBtn);

    // Without this the overlay is a dead end: a phone with no CORE LINK
    // session could not reach anything underneath it, including the
    // Core/Galaxy toggle, even though that view is public by design.
    const skipBtn = document.createElement('button');
    skipBtn.className = 'link';
    skipBtn.textContent = 'Continue without unlocking (public snapshot)';
    skipBtn.onclick = () => dismissGate(gate);
    refs.body.appendChild(skipBtn);
  }

  function renderOtpRequest(gate, refs, purpose) {
    refs.body.innerHTML = '';
    const info = document.createElement('p');
    info.className = 'sub';
    info.style.margin = '0 0 10px';
    info.textContent = purpose === 'enroll'
      ? 'This device has no passkey yet. We’ll email a code to prove it’s you, then register it.'
      : 'A code will be emailed to you. Enter it below once it lands.';
    refs.body.appendChild(info);

    const sendBtn = document.createElement('button');
    sendBtn.className = 'primary';
    sendBtn.textContent = 'Send code to business email';
    refs.body.appendChild(sendBtn);

    const backupBtn = document.createElement('button');
    backupBtn.className = 'link';
    backupBtn.textContent = "Can't access that inbox? Send to backup email";
    refs.body.appendChild(backupBtn);

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.placeholder = '6-digit code';
    codeInput.maxLength = 6;
    codeInput.style.display = 'none';
    refs.body.appendChild(codeInput);

    const verifyBtn = document.createElement('button');
    verifyBtn.className = 'primary';
    verifyBtn.textContent = 'Verify code';
    verifyBtn.style.display = 'none';
    refs.body.appendChild(verifyBtn);

    const backBtn = document.createElement('button');
    backBtn.className = 'link';
    backBtn.textContent = '← Back';
    backBtn.onclick = () => renderChoice(gate, refs);
    refs.body.appendChild(backBtn);

    async function send(useBackup) {
      setMsg(refs, '', false);
      sendBtn.disabled = true; backupBtn.disabled = true;
      try {
        const deviceType = detectDeviceType();
        const result = await apiPost('/api/auth/otp/request', {
          purpose, useBackup,
          deviceType, deviceLabel: deviceType === 'phone' ? 'Phone (Face ID)' : deviceType === 'laptop' ? 'Laptop (Touch ID)' : 'Device',
        });
        setMsg(refs, `Code sent to your ${result.target} email.`, true);
        codeInput.style.display = ''; verifyBtn.style.display = '';
        codeInput.focus();
      } catch (err) {
        setMsg(refs, err.message, false);
      } finally {
        sendBtn.disabled = false; backupBtn.disabled = false;
      }
    }
    sendBtn.onclick = () => send(false);
    backupBtn.onclick = () => send(true);

    verifyBtn.onclick = async () => {
      setMsg(refs, '', false);
      verifyBtn.disabled = true;
      try {
        const result = await apiPost('/api/auth/otp/verify', { code: codeInput.value.trim() });
        if (result.purpose === 'enroll') {
          await registerPasskey(gate, refs, result.enrollToken);
        } else {
          rememberSession(result);
          finishAuth(gate);
        }
      } catch (err) {
        setMsg(refs, err.message, false);
      } finally {
        verifyBtn.disabled = false;
      }
    };
  }

  async function registerPasskey(gate, refs, enrollToken) {
    setMsg(refs, 'Registering this device…', true);
    try {
      const deviceType = detectDeviceType();
      const deviceLabel = deviceType === 'phone' ? 'Phone (Face ID)' : deviceType === 'laptop' ? 'Laptop (Touch ID)' : 'Device';
      const optRes = await apiPost('/api/auth/webauthn/register/options', { enrollToken, deviceType, deviceLabel });
      const publicKey = credentialCreationOptionsFromJSON(optRes.options);
      const cred = await navigator.credentials.create({ publicKey });
      const result = await apiPost('/api/auth/webauthn/register/verify', { enrollToken, response: registrationResponseToJSON(cred) });
      rememberSession(result);
      finishAuth(gate);
    } catch (err) {
      setMsg(refs, err.message || 'Could not register this device.', false);
    }
  }

  /* iOS Safari only honours navigator.credentials.get() while the tap that
     triggered it still holds transient user activation. Awaiting a network
     round trip for the challenge first spends that activation, so the call
     rejects with NotAllowedError and the Face ID sheet never appears — which
     is exactly how the phone ended up never asking for anything. Fetch the
     challenge ahead of the tap and keep the handler synchronous up to the
     credentials.get() call. */
  const LOGIN_OPTIONS_TTL_MS = 45000; // server challenge lives 60s; stay inside it
  let warmLoginOptions = null;
  let warmLoginOptionsAt = 0;
  let warmLoginInFlight = false;
  function prefetchLoginOptions(force) {
    if (warmLoginInFlight) return;
    if (!force && warmLoginOptions && Date.now() - warmLoginOptionsAt < LOGIN_OPTIONS_TTL_MS) return;
    warmLoginInFlight = true;
    apiPost('/api/auth/webauthn/login/options', {})
      .then((optRes) => { warmLoginOptions = (optRes && optRes.options) || null; warmLoginOptionsAt = Date.now(); })
      .catch(() => { warmLoginOptions = null; })
      .finally(() => { warmLoginInFlight = false; });
  }
  // Single-use: a challenge may only be spent once, so hand it out and drop it.
  function takeWarmLoginOptions() {
    const opts = warmLoginOptions;
    if (!opts) return null;
    if (Date.now() - warmLoginOptionsAt >= LOGIN_OPTIONS_TTL_MS) { warmLoginOptions = null; return null; }
    warmLoginOptions = null;
    return opts;
  }

  function loginWithPasskey(gate, refs) {
    setMsg(refs, '', false);
    const warm = takeWarmLoginOptions();
    if (!warm) {
      // No warm challenge (first paint raced the tap, or the fetch failed).
      // Fall back to the async path; on iOS the gesture may be lost, but the
      // error is now reported honestly and the retry runs warm.
      prefetchLoginOptions(true);
      return loginWithPasskeyCold(gate, refs);
    }
    if (!warm.allowCredentials || warm.allowCredentials.length === 0) {
      // Nothing registered anywhere yet — first-ever setup goes through email.
      return renderOtpRequest(gate, refs, 'enroll');
    }
    let request;
    try {
      request = navigator.credentials.get({ publicKey: credentialRequestOptionsFromJSON(warm) });
    } catch (err) {
      return handlePasskeyError(gate, refs, err);
    }
    setMsg(refs, `Waiting for ${platformLabel(detectDeviceType())}…`, true);
    completePasskeyLogin(gate, refs, request);
  }

  async function loginWithPasskeyCold(gate, refs) {
    try {
      const optRes = await apiPost('/api/auth/webauthn/login/options', {});
      if (!optRes.options.allowCredentials || optRes.options.allowCredentials.length === 0) {
        return renderOtpRequest(gate, refs, 'enroll');
      }
      const publicKey = credentialRequestOptionsFromJSON(optRes.options);
      await completePasskeyLogin(gate, refs, navigator.credentials.get({ publicKey }), false);
    } catch (err) {
      handlePasskeyError(gate, refs, err);
    }
  }

  /* The server keeps a single global currentAuthChallenge (auth.js), so the
     last challenge issued anywhere wins. Warming one ahead of the tap means a
     second device merely opening the gate can invalidate this one. Rare, but
     it would otherwise turn a successful Face ID into a hard failure, so on a
     rejected verify fall back to the cold path once and re-issue. */
  async function completePasskeyLogin(gate, refs, request, allowRetry) {
    let cred;
    try {
      cred = await request;
    } catch (err) {
      return handlePasskeyError(gate, refs, err);
    }
    try {
      const result = await apiPost('/api/auth/webauthn/login/verify', { response: authenticationResponseToJSON(cred) });
      rememberSession(result);
      finishAuth(gate);
    } catch (err) {
      if (allowRetry !== false) {
        setMsg(refs, 'Re-checking with the core…', true);
        return loginWithPasskeyCold(gate, refs);
      }
      handlePasskeyError(gate, refs, err);
    }
  }

  /* The old handler sent every failure to the enrollment screen, so a phone
     that already holds a passkey was told it had none and was pushed at an
     email code instead. WebAuthn deliberately returns the same NotAllowedError
     whether the user cancelled, the sheet timed out, or no credential matched,
     so the honest move is to return to the choice screen — both routes one tap
     away — and say which two things it could be. */
  function handlePasskeyError(gate, refs, err) {
    prefetchLoginOptions(true);
    const name = err && err.name;
    const label = platformLabel(detectDeviceType());
    if (name === 'NotAllowedError' || name === 'AbortError' || name === 'TimeoutError') {
      renderChoice(gate, refs);
      setMsg(refs, `${label} didn't complete — cancelled, timed out, or this device was never enrolled. Tap to try again, or use an email code to register it.`, false);
      return;
    }
    if (name === 'SecurityError' || name === 'NotSupportedError') {
      renderChoice(gate, refs);
      setMsg(refs, `${label} isn't available in this browser. Use an email code instead.`, false);
      return;
    }
    renderChoice(gate, refs);
    setMsg(refs, (err && err.message) || 'Unlock failed.', false);
  }

  function setMsg(refs, text, ok) {
    refs.msg.textContent = text || '';
    refs.msg.className = 'msg' + (ok ? ' ok' : '');
  }

  /* Waiters are a LIST, not a single slot. index.html can have two callers
     waiting on the same gate (the CORE LINK handshake and the app boot); the
     old single-slot version silently dropped the first one, leaving its
     promise pending forever and every /api/ call queued behind it. */
  let authedCbs = [];
  let cancelCbs = [];
  function addWaiters(onAuthed, onCancel) {
    if (typeof onAuthed === 'function') authedCbs.push(onAuthed);
    if (typeof onCancel === 'function') cancelCbs.push(onCancel);
  }
  function drainWaiters(which) {
    const cbs = which === 'authed' ? authedCbs : cancelCbs;
    authedCbs = []; cancelCbs = [];
    cbs.forEach((cb) => { try { cb(); } catch (_) { /* one waiter must not stop the rest */ } });
  }
  function finishAuth(gate) {
    if (gate) gate.classList.add('hidden');
    if (window.CortanaDeviceManager) window.CortanaDeviceManager.refresh();
    drainWaiters('authed');
  }

  /* Dismissing the gate grants nothing — it only stops a full-screen overlay
     from holding the public snapshot hostage. The caller treats this as "not
     authenticated" and falls back to the sanitized static data, so the live
     core stays just as locked as it was before the tap. */
  function dismissGate(gate) {
    // Hide, don't remove: the same overlay has to be re-openable later, both
    // for "Log in again" and for a session that dies mid-session.
    if (gate) gate.classList.add('hidden');
    drainWaiters('cancel');
  }

  // One overlay for the life of the page, reopened rather than re-appended.
  // The old code built a fresh #authGate on every call, so a second gate could
  // stack on the first with a duplicate id and stale handlers underneath it.
  let gateEl = null;
  let gateRefs = null;
  function openGate() {
    if (!gateEl || !document.body.contains(gateEl)) {
      gateEl = buildOverlay();
      gateRefs = { body: gateEl.querySelector('#authGateBody'), msg: gateEl.querySelector('#authGateMsg') };
    }
    gateEl.classList.remove('hidden');
    return gateEl;
  }

  window.initAuthGate = async function initAuthGate(onAuthed, opts) {
    applyTransport(opts);
    addWaiters(onAuthed, opts && opts.onCancel);
    buildDeviceManager();
    // opts.force skips the "are we already in?" probe — that probe is exactly
    // what a stale-but-not-yet-rejected cookie sails through, which is how a
    // dead session kept being mistaken for a live one.
    if (!(opts && opts.force)) {
      let authenticated = false;
      try {
        const status = await api('/api/auth/session');
        authenticated = !!status.authenticated;
      } catch (_) { /* treat as unauthenticated */ }
      if (authenticated) { finishAuth(gateEl); return; }
    }
    const gate = openGate();
    setMsg(gateRefs, '', false);
    renderChoice(gate, gateRefs);
  };

  /* The explicit way back in. Nothing else on the page could force a fresh
     unlock: the overlay only ever appeared during boot, so once a session died
     mid-use there was no login left to offer — the CORE LINK button read
     "Core Live" and its only action was to disconnect. Resolves true once the
     core has minted a new session, false if Chief backs out. */
  window.CortanaAuth.relogin = function relogin(opts) {
    applyTransport(opts);
    return new Promise((resolve) => {
      clearRememberedSession();
      // Drop the server-side session too, so a half-dead cookie can't answer
      // the next probe with "authenticated" and skip the gate all over again.
      apiPost('/api/auth/logout').catch(() => {}).then(() => {
        clearRememberedSession();
        window.initAuthGate(
          () => resolve(true),
          Object.assign({}, opts, { force: true, onCancel: () => resolve(false) }),
        );
      });
    });
  };

  // ---- device management (list / revoke registered passkey devices) ----
  let deviceManagerBuilt = false;
  function buildDeviceManager() {
    if (deviceManagerBuilt) return;
    deviceManagerBuilt = true;

    const btn = document.createElement('button');
    btn.id = 'authDeviceBtn';
    btn.title = 'Manage CORE LINK devices';
    btn.textContent = '⚙ Devices';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '14px', left: '14px', zIndex: 999998,
      background: 'rgba(3,10,9,.82)', color: 'rgba(160,220,210,.75)',
      border: '1px solid rgba(120,231,208,.28)', borderRadius: '6px',
      font: '11px sans-serif', padding: '6px 10px', cursor: 'pointer',
    });

    const panel = document.createElement('div');
    panel.id = 'authDevicePanel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '48px', left: '14px', zIndex: 999998, display: 'none',
      width: '280px', background: 'rgba(3,10,9,.94)', border: '1px solid rgba(120,231,208,.32)',
      borderRadius: '8px', padding: '14px', color: 'rgba(210,255,244,.9)', font: '12px sans-serif',
    });

    /* The device list needs a session to load. When there isn't one the old
       panel replaced its whole contents with the 401 text — taking the only
       login/logout controls on the page down with it, precisely when Chief
       needed them. Keep the controls in a footer the list can never clear. */
    const listEl = document.createElement('div');
    const footerEl = document.createElement('div');
    panel.appendChild(listEl);
    panel.appendChild(footerEl);

    async function refresh() {
      listEl.innerHTML = '<div style="opacity:.6">Loading…</div>';
      try {
        const { devices } = await api('/api/auth/devices');
        listEl.innerHTML = '';
        const title = document.createElement('div');
        title.textContent = 'Registered devices';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;text-transform:uppercase;font-size:10px;color:rgba(255,214,109,.8)';
        listEl.appendChild(title);
        if (!devices.length) {
          const none = document.createElement('div');
          none.style.opacity = '.6';
          none.textContent = 'No passkeys registered yet — email code was used to sign in.';
          listEl.appendChild(none);
        }
        devices.forEach((d) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(120,231,208,.14)';
          const label = document.createElement('span');
          label.textContent = (d.current ? '● ' : '') + d.label;
          row.appendChild(label);
          const revokeBtn = document.createElement('button');
          revokeBtn.textContent = 'Revoke';
          revokeBtn.style.cssText = 'background:none;border:1px solid rgba(255,120,120,.4);color:rgba(255,160,160,.85);border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer';
          revokeBtn.onclick = async () => {
            revokeBtn.disabled = true;
            try { await apiPost('/api/auth/devices/revoke', { id: d.id }); await refresh(); }
            catch (err) { alert(err.message); revokeBtn.disabled = false; }
          };
          row.appendChild(revokeBtn);
          listEl.appendChild(row);
        });
      } catch (err) {
        listEl.innerHTML = '';
        const msg = document.createElement('div');
        msg.style.cssText = 'color:rgba(255,150,150,.85)';
        msg.textContent = err.message;
        listEl.appendChild(msg);
      }
    }

    const ctlStyle = 'margin-top:10px;width:100%;padding:7px;background:rgba(120,231,208,.08);border:1px solid rgba(120,231,208,.3);color:inherit;border-radius:5px;cursor:pointer;font-size:11px';
    const loginBtn = document.createElement('button');
    loginBtn.id = 'authReloginBtn';
    loginBtn.textContent = 'Log in again';
    loginBtn.title = 'Force a fresh CORE LINK unlock, even if this page thinks it is already connected';
    loginBtn.style.cssText = ctlStyle + ';border-color:rgba(255,196,46,.5);background:rgba(255,196,46,.10)';
    loginBtn.onclick = async () => {
      panel.style.display = 'none';
      // index.html owns the CORE LINK button label and the switchboard, so let
      // it drive when it's there; fall back to a bare re-unlock on localhost.
      if (window.cortanaReconnectCore) await window.cortanaReconnectCore();
      else await window.CortanaAuth.relogin();
      refresh();
    };
    footerEl.appendChild(loginBtn);

    const logoutBtn = document.createElement('button');
    logoutBtn.id = 'authLogoutBtn';
    logoutBtn.textContent = 'Log out this device';
    logoutBtn.style.cssText = ctlStyle;
    logoutBtn.onclick = async () => {
      try { await apiPost('/api/auth/logout'); } catch (_) { /* log out locally regardless */ }
      clearRememberedSession();
      location.reload();
    };
    footerEl.appendChild(logoutBtn);

    btn.onclick = () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (!open) refresh();
    };

    document.body.appendChild(btn);
    document.body.appendChild(panel);
    window.CortanaDeviceManager = { refresh: () => { if (panel.style.display !== 'none') refresh(); } };
  }

  window.CortanaAuth = { ...window.CortanaAuth, api, apiPost };
})();
