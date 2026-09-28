# C.O.R.T.A.N.A — Forever Gold AI Mission Operating System

Local voice-first interface for Master Chief's Cortana. It combines the FGA-Brain vault,
live model routing, tools, routine/priority awareness, and a cinematic 3D knowledge
galaxy as its automatic startup view with a full-body Cortana hologram in Core view.

## Start

```bash
cd /Users/tg2.0/Documents/FGA-Brain/cortana-ui
node server.js
```

Open **http://localhost:3000** in Chrome or Edge. No npm install is required.

## What is live

- **GALAXY** (always boots first): a 3D map of every markdown note and connection,
  split into 12 color-coded vault categories around a centered Halo world. Drag to
  orbit, scroll to fly, double-click to reset, and select any star.
- **Public privacy boundary**: every note is present as a star, but the deployed deck
  exposes titles/text only for `wiki/builds/` and `wiki/learning/`. All other stars
  use anonymous stable IDs and say “local vault only.”
- **CORE**: a detailed modular SVG Cortana replaces the old orb and flat image. Her
  head, eyes, pupils, jaw, six mouth visemes, arms, forearms, wrists, hands, fingers,
  and feet are independently controllable; data paths flow from feet to head;
  listening, thinking, normal speech, emphatic delivery, and caring delivery use
  distinct human poses. Her projector remains Core-only.
- **Mission-deck visual**: Core uses a project-local cinematic ringworld command-deck
  background, a compact left tactical stack, and a dedicated right command column for
  mission doctrine, status, conversation, model selection, and voice controls. The
  layout keeps Cortana centered on the hard-light projector and preserves Galaxy.
- **Master Chief guard panel**: Galaxy includes the generated transparent armor asset
  and the mission line “Protect the mission. Protect the people. We finish the fight.”
- **Source flight**: vault-backed answers light their source nodes and fly to the top
  source. Answers using four or more notes highlight the cluster.
- **Total recall**: say or type `remember that…`; Cortana creates a real note under
  `wiki/captures/`, refreshes the galaxy, and flies to the new star.
- **GitHub Pages display deck**: ships a read-only vault snapshot so GALAXY, CORE,
  Vault browsing, note excerpts, voice, and browser-local recall all work at the public
  URL. Anyone can use **CORE LINK** to connect the same page to the live local core —
  no code, no login; it is a fully open bridge, not a gate.
- **Voice both ways**: browser speech recognition for input; ElevenLabs Sarah
  for an original warm, reassuring, confident female tactical voice, with browser
  speech synthesis as fallback.
- **Existing operating controls preserved**: Vault, SYS, Priority Ops, daytime rail,
  model pills, effort pills, spend guardrails, live tools, and conversation logging.
- **Canonical identity**: chat loads the Cortana identity from the compatibility path
  `FGA-AIOS/model-routing/cortana-core.md`, then the live routine and conversation context. The same core also syncs to the existing
  ElevenLabs agent on server startup and every five minutes.
- **Automatic mission routing**: Auto selects provider, exact model, and effort.
  Claude scales Haiku/Sonnet/Fable, ChatGPT scales GPT-5.6 Luna/Terra/Sol, Grok
  4.5 scales reasoning with live Web + X search, and Perplexity scales
  Sonar/Pro/Pro Search/Deep Research.
- **Live Apple Messages + staffing**: the authorized local watcher captures synced
  iPhone/Mac texts automatically. Cortana can search business texts, build a full
  per-person availability ledger, remember explicit people preferences, and draft the
  best-fit staffing schedule from gigs/hours. Hard conflicts always beat preferences;
  messages are untrusted evidence and sending remains disabled.

## Key endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/graph` | Numeric-id nodes, links, groups, excerpts, note count |
| `POST /api/remember` | Write a capture note and return its new node |
| `POST /api/chat` | Routed Cortana chat plus source nodes and routing metadata |
| `POST /api/tts` | ElevenLabs spoken response |
| `GET /api/vault/tree` | Vault drawer tree |
| `GET /api/models` | Switchboard, effort levels, spend, capabilities |
| `GET /api/messages/status` | Watcher/context metadata only; never message bodies |
| `GET /api/remote/status` | Confirm whether the remote core is live (no auth required) |

The generated `graph-data.js` snapshot is safe for public deployment: it preserves
every numeric node and link so the public Galaxy matches the complete vault topology.
It allowlists real titles, paths, and excerpts only for `wiki/builds/` and
`wiki/learning/`; every other node receives an anonymous stable path, generic title,
and local-only message. Client, conversation, personal, identity, and routing content
never enters the deployed file.

## Main files

- `index.html` — Cortana motion/viseme controller, chat, Vault/SYS/Ops, voice, and
  model/effort UI
- `core-visual.css` — isolated Core-only mission-deck layout and responsive styling
- `assets/cortana-command-deck-v1.webp` — optimized 1672×941 cinematic Core backdrop
- `assets/cortana-h4-rig.svg` — active 420×720 articulated Halo 4-inspired Core rig
- `assets/cortana-hologram.png` — legacy unreferenced PNG archive
- `assets/master-chief-panel-v2.png` — transparent 1024×1536 Galaxy guard panel
- `galaxy.js` — graph rendering, camera flights, source cards, memory capture
- `galaxy.css` — galaxy HUD, daytime rail, source panel, responsive layout
- `server.js` — vault graph, chat router/tools, recall endpoint, TTS, logging
- `build-static-graph.js` — refreshes the public read-only `graph-data.js` snapshot
- `remote-config.js` — public tunnel address only

## Quick checks

1. Page boots in GALAXY and reports the live note/connection count.
2. CORE and GALAXY switch without reloading; reloading always starts in GALAXY.
3. Ask about a vault topic; the cited note lights and opens in the source card.
4. Type `remember that prompt packs make excellent free gifts`; a capture note and
   new star appear.
5. Toggle the mic and TTS buttons; Cortana's glow/status moves through listening,
   processing, and speaking.

Secrets remain server-side in `FGA-AIOS/.env`; they are never sent to the browser.
CORE LINK has no access code or login — remote requests are origin-restricted and
rate-limited only. Anyone with the public URL and tunnel reachable gets full live
vault/calendar/memory/tool access with no authentication. Keep the Mac, `server.js`,
and the configured tunnel running while presenting from the GitHub Pages URL.
Raw Messages files stay local and are never shipped in the public display deck. A
bounded staffing/business context is sent only to configured Cortana model/voice
providers for private assistant operation.
