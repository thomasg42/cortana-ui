# C.O.R.T.A.N.A — GitHub Pages + Private Core Link

Live at **https://thomasg42.github.io/cortana-ui/**.

This static deployment preserves the full Halo green/gold interface and boots into
**CORE** (holotank hologram) by default, with the prior Galaxy preference restored from
`localStorage` when set. The **CORE / GALAXY** toggle, Vault drawer, SYS panel, Priority Ops,
daytime rail, voice controls, and model/effort switchboard remain visible and usable.

Because GitHub Pages cannot run `server.js`, the unauthenticated build ships a sanitized, read-only
Galaxy snapshot containing every vault star and connection. Only `wiki/builds/` and
`wiki/learning/` expose real titles, paths, or excerpts. Every other star receives an
anonymous stable ID and local-vault-only notice; public Open/Context actions are
disabled. Display-deck captures stay in that browser.

Anyone who presses **CORE LINK** reaches the live local core through the URL in
`remote-config.js` — no code, no login, no bearer token. This is a fully open bridge:
whoever has the public URL gets full live vault, calendar, memory, and tool access.
Provider keys and vault content never enter the deploy repository, but the
CORE LINK bridge itself is unauthenticated by design. Keep the Mac, local server, and
tunnel running for the duration of the showcase.
Apple Messages inbox/context/profile files, message bodies, watcher health, and live
staffing tools are local-core-only and must never be copied into this deploy repository.

Source of truth: `/Users/tg2.0/Documents/FGA-Brain/cortana-ui/`.

## Rotating the CORE LINK tunnel

Whenever the Cloudflare Quick Tunnel restarts (new hostname) — including after the
old one silently expires while its process looks alive — run this from
`cortana-ui/` instead of hand-editing files:

```
./rotate-tunnel.sh                                   # auto-detects newest URL from cloudflared.log
./rotate-tunnel.sh https://xxx.trycloudflare.com      # or pass one explicitly
```

It is the single propagation point: updates `remote-config.js` (source), syncs the
copy in `~/Documents/cortana-ui/`, updates the "Live tunnel as of" line below, commits
and pushes the deploy repo if the URL actually changed, and verifies the live file
on GitHub Pages matches. Do not edit `remote-config.js` or this file's tunnel line by
hand — use the script so nothing goes stale.

## Deploy

1. Run `node build-static-graph.js` from the source directory while the local core is up.
   If it is on another port, set `CORTANA_CORE_URL`, for example
   `CORTANA_CORE_URL=http://127.0.0.1:3100 node build-static-graph.js`.
2. Run the privacy invariant check described in
   `wiki/builds/ai-companion-mission-control-playbook.md`.
3. Copy `index.html`, `core-visual.css`, `galaxy.css`, `galaxy.js`, `chat.html`,
   `graph-data.js`, `remote-config.js`, and `README.md` into
   `~/Documents/cortana-ui/`.
4. Copy `assets/cortana-3d.glb` into the deploy repo's `assets/` folder — this is the
   live Core visual as of 2026-07-29 (Meshy-generated model, 4K PBR textures baked in:
   base color, normal, metallic/roughness, emissive glow map). `index.html` loads it via
   `THREE.GLTFLoader` (see `<script>` block after the three.min.js include) and falls
   back to `assets/cortana-hologram.png` → the inline `legacyFigure` SVG if the GLB
   fails to load. `assets/cortana-h4-rig.svg` and `assets/master-chief-panel-v2.png` are
   now legacy fallback-chain assets, not the primary visual, but still required.
5. Copy `assets/cortana-command-deck-v1.webp` into the deploy repo's `assets/`
   folder. It is the Core-only 1672×941 ringworld command-deck background referenced
   by `core-visual.css`; Galaxy does not render it.
6. Commit and push `main`, wait for Pages, then verify live hashes, desktop/mobile,
   Core/Galaxy switching, both required asset hashes, all avatar states/visemes, and
   zero console errors.

After each publish, record the production commit in
`wiki/builds/cortana-mission-control.md` and rerun desktop/mobile browser QA.

Verified production head: `2fc57f4` (2026-07-29, Lane 2 Codex) — live Core
mission-deck visual with `assets/cortana-command-deck-v1.webp`,
`core-visual.css`, the centered 3D Cortana projector, left tactical field, and right
mission/chat/control column. Pages completed from `main` `/` with HTTPS enforced;
published HTML/CSS/WebP hashes matched source, and live QA passed at 1280×720 and
390×844 with no horizontal overflow.
Live tunnel as of 2026-07-29: `https://aaa-shaved-expects-creativity.trycloudflare.com`
(Cloudflare Quick Tunnel — process-bound, changes whenever the Mac/server/tunnel
restart; update `remote-config.js` and redeploy if CORE LINK stops responding).
The 2026-07-15 tunnel hostname expired between sessions with the process still
running but unresolvable — same will happen to this one; always curl the tunnel URL
directly before assuming CORE LINK is live.

Prior heads: `dfe2c97` (Cortana artwork v3), `0615843` (CORE LINK access code removed at Thomas's explicit, confirmed
request — open bridge: no login, no code, no bearer token; CORS origin allowlisting
and rate limits are the only remaining guards), `c179487` (artist-grade Cortana artwork v2 in `assets/cortana-h4-rig.svg`
— full facial redesign, fingered hands, planted feet, circuit suit), `c3ba7be`
(authenticated Core Link, first detailed rig), visual and bridge implementation in
`e203200`. The rig artwork is generated by `build-cortana-rig.mjs` in the source
directory; Codex's first rig is preserved as `assets/cortana-h4-rig.svg.bak-codex`.

Pre-Cortana backups remain as `*.bak-preCortana` in the source directory.
