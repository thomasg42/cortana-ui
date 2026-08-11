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
  function apiUrl(path) { return activeBase + path; }

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

  async function loginWithPasskey(gate, refs) {
    setMsg(refs, '', false);
    try {
      const optRes = await apiPost('/api/auth/webauthn/login/options', {});
      if (!optRes.options.allowCredentials || optRes.options.allowCredentials.length === 0) {
        // No devices registered yet anywhere — first-ever setup goes through email.
        return renderOtpRequest(gate, refs, 'enroll');
      }
      const publicKey = credentialRequestOptionsFromJSON(optRes.options);
      const cred = await navigator.credentials.get({ publicKey });
      const result = await apiPost('/api/auth/webauthn/login/verify', { response: authenticationResponseToJSON(cred) });
      rememberSession(result);
      finishAuth(gate);
    } catch (err) {
      // Most common case: this device has no registered passkey yet.
      renderOtpRequest(gate, refs, 'enroll');
      setMsg(refs, err && err.name === 'NotAllowedError' ? '' : (err.message || ''), false);
    }
  }

  function setMsg(refs, text, ok) {
    refs.msg.textContent = text || '';
    refs.msg.className = 'msg' + (ok ? ' ok' : '');
  }

  let onAuthedCb = null;
  let onCancelCb = null;
  function finishAuth(gate) {
    gate.classList.add('hidden');
    onCancelCb = null;
    if (window.CortanaDeviceManager) window.CortanaDeviceManager.refresh();
    if (onAuthedCb) { const cb = onAuthedCb; onAuthedCb = null; cb(); }
  }

  /* Dismissing the gate grants nothing — it only stops a full-screen overlay
     from holding the public snapshot hostage. The caller treats this as "not
     authenticated" and falls back to the sanitized static data, so the live
     core stays just as locked as it was before the tap. */
  function dismissGate(gate) {
    gate.remove();
    onAuthedCb = null;
    if (onCancelCb) { const cb = onCancelCb; onCancelCb = null; cb(); }
  }

  window.initAuthGate = async function initAuthGate(onAuthed, opts) {
    activeFetch = (opts && opts.fetchImpl) || window.fetch.bind(window);
    activeBase = (opts && opts.base) || '';
    onCancelCb = (opts && opts.onCancel) || null;
    onAuthedCb = onAuthed;
    let authenticated = false;
    try {
      const status = await api('/api/auth/session');
      authenticated = !!status.authenticated;
    } catch (_) { /* treat as unauthenticated */ }
    buildDeviceManager();
    if (authenticated) { onAuthedCb = null; onAuthed(); return; }
    const gate = buildOverlay();
    const refs = { body: gate.querySelector('#authGateBody'), msg: gate.querySelector('#authGateMsg') };
    renderChoice(gate, refs);
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

    async function refresh() {
      panel.innerHTML = '<div style="opacity:.6">Loading…</div>';
      try {
        const { devices } = await api('/api/auth/devices');
        panel.innerHTML = '';
        const title = document.createElement('div');
        title.textContent = 'Registered devices';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;text-transform:uppercase;font-size:10px;color:rgba(255,214,109,.8)';
        panel.appendChild(title);
        if (!devices.length) {
          const none = document.createElement('div');
          none.style.opacity = '.6';
          none.textContent = 'No passkeys registered yet — email code was used to sign in.';
          panel.appendChild(none);
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
          panel.appendChild(row);
        });
        const logoutBtn = document.createElement('button');
        logoutBtn.textContent = 'Log out this device';
        logoutBtn.style.cssText = 'margin-top:12px;width:100%;padding:6px;background:rgba(120,231,208,.08);border:1px solid rgba(120,231,208,.3);color:inherit;border-radius:5px;cursor:pointer;font-size:11px';
        logoutBtn.onclick = async () => { await apiPost('/api/auth/logout'); location.reload(); };
        panel.appendChild(logoutBtn);
      } catch (err) {
        panel.innerHTML = `<div style="color:rgba(255,150,150,.85)">${err.message}</div>`;
      }
    }

    btn.onclick = () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (!open) refresh();
    };

    document.body.appendChild(btn);
    document.body.appendChild(panel);
    window.CortanaDeviceManager = { refresh: () => { if (panel.style.display !== 'none') refresh(); } };
  }

  window.CortanaAuth = { api, apiPost };
})();
