// Public runtime endpoint only. This file must never contain credentials.
// The tunnel URL is inserted during the authorized deploy. CORE LINK behind
// this URL is gated by passkey (Touch ID/Face ID) or an emailed one-time
// code as of 2026-07-30 — see auth.js and auth-gate.js.
window.CORTANA_REMOTE_CORE_URL = 'https://terminals-tours-italic-redeem.trycloudflare.com';
