// FGA Command Center — one aggregated business view.
//
// Pulls every operating surface Thomas asked to see in one place: inbox,
// calendar, clients, live pages, outreach, marketing, projects, automations,
// money. Structure over styling — command-center.html is a deliberately plain
// shell so Codex can restyle it without touching any of this logic.
//
// Two hard rules this module holds to:
//   1. NEVER throw. One dead source (gws blocked, n8n quota lockout, no
//      network) must degrade that one card, never blank the page. Every
//      collector returns { status, error?, ... } and is run through allSettled.
//   2. NEVER fabricate. Unknown money, unknown counts, and unconfirmed
//      figures stay null and are labelled UNCONFIRMED. A blank is information;
//      a guess compounds.
//
// Dependencies are injected (see buildCommandCenter) so the whole thing is
// testable without booting the server or holding live credentials.

const fs = require('fs');
const path = require('path');
const planning = require('./command-center-state.js');

const SECTIONS = [
  'pulse', 'outreach', 'money', 'inbox', 'calendar', 'clients',
  'pages', 'projects', 'marketing', 'automations', 'tasks', 'journal',
];

// Per-section cache TTL in ms. File-backed sections are cheap and re-read every
// request (ttl 0) so a hand-edit to registry.json shows up immediately. The
// slow ones — each gws call shells out and takes seconds — are cached.
const TTL = {
  pulse: 0, outreach: 0, money: 0, clients: 0, projects: 0,
  marketing: 60 * 1000, tasks: 0, journal: 30 * 1000,
  inbox: 5 * 60 * 1000,
  calendar: 5 * 60 * 1000,
  pages: 10 * 60 * 1000,
  automations: 5 * 60 * 1000,
};

const cache = new Map();

function invalidateCache(section) {
  if (section) cache.delete(section); else cache.clear();
}

function cached(section, refresh, producer) {
  const ttl = TTL[section] ?? 0;
  const hit = cache.get(section);
  const now = Date.now();
  if (!refresh && ttl > 0 && hit && now - hit.at < ttl) {
    return Promise.resolve({ ...hit.value, cached: true, cached_at: new Date(hit.at).toISOString() });
  }
  return Promise.resolve()
    .then(producer)
    .then((value) => {
      if (ttl > 0) cache.set(section, { at: now, value });
      return { ...value, cached: false };
    })
    .catch((err) => ({ status: 'error', error: String(err && err.message || err) }));
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

// gws and n8nRequest both signal failure by *returning* an error string rather
// than throwing, so every call site has to sniff for it.
function isToolError(out) {
  if (typeof out !== 'string') return false;
  return /^gws error:/i.test(out) || /^n8n API \d/i.test(out) || /^n8n is not configured/i.test(out);
}

function parseJsonOutput(out) {
  if (typeof out !== 'string' || isToolError(out)) return { ok: false, error: typeof out === 'string' ? out : 'no output' };
  try { return { ok: true, data: JSON.parse(out) }; } catch { return { ok: false, error: `unparseable output: ${out.slice(0, 200)}` }; }
}

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fileAgeDays(file) {
  try {
    const stat = fs.statSync(file);
    return Math.floor((Date.now() - stat.mtimeMs) / 86400000);
  } catch { return null; }
}

// Newest mtime anywhere under a directory, capped so a huge tree can't stall a
// request. Used as the "last touched" signal for a client or project folder.
function newestMtime(dir, budget = 1500) {
  let newest = 0;
  let seen = 0;
  const walk = (d) => {
    if (seen >= budget) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= budget) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      seen += 1;
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* unreadable file, skip */ }
    }
  };
  walk(dir);
  return newest ? new Date(newest).toISOString() : null;
}

// ---------------------------------------------------------------------------
// registry + outreach log (the two files a human edits)
// ---------------------------------------------------------------------------

function registryPath(vaultRoot) {
  return path.join(vaultRoot, 'FGA-AIOS', 'command-center', 'registry.json');
}

function outreachLogPath(vaultRoot) {
  return path.join(vaultRoot, 'FGA-AIOS', 'command-center', 'outreach-log.json');
}

function loadRegistry(vaultRoot) {
  const file = registryPath(vaultRoot);
  let data;
  try { data = planning.validateRegistry(fs.readFileSync(file, 'utf8')); } catch { data = null; }
  if (!data) {
    return {
      __error: `registry not readable at ${file}`,
      targets: {}, businesses: [], pages: [], backends: [],
      inbox_queries: [], projects: [], marketing: {},
    };
  }
  return data;
}

function loadOutreachLog(vaultRoot) {
  return readJson(outreachLogPath(vaultRoot), { days: {} }) || { days: {} };
}

// Records outreach activity for a day. Deliberately additive (delta), because
// Thomas logs calls in batches through the day and an absolute set would lose
// counts if two surfaces wrote at once.
function recordOutreach(vaultRoot, { calls = 0, emails = 0, note = '', day } = {}) {
  const key = day || localDateKey();
  const log = loadOutreachLog(vaultRoot);
  if (!log.days) log.days = {};
  const entry = log.days[key] || { calls: 0, emails: 0, notes: [] };
  entry.calls = Math.max(0, (Number(entry.calls) || 0) + (Number(calls) || 0));
  entry.emails = Math.max(0, (Number(entry.emails) || 0) + (Number(emails) || 0));
  if (note) {
    if (!Array.isArray(entry.notes)) entry.notes = [];
    entry.notes.push({ at: new Date().toISOString(), note: String(note).slice(0, 500) });
  }
  entry.updated_at = new Date().toISOString();
  log.days[key] = entry;
  log.updated_at = entry.updated_at;
  const file = outreachLogPath(vaultRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 2) + '\n', 'utf-8');
  return { day: key, ...entry };
}

// ---------------------------------------------------------------------------
// collectors
// ---------------------------------------------------------------------------

const FALLBACK_SCHEDULE = [
  { time: '8:00 AM', block: 'Rise & Ground' },
  { time: '8:15 AM', block: 'Move — jog' },
  { time: '8:45 AM', block: 'Fuel + Prime' },
  { time: '9:30 AM', block: 'REVENUE BLOCK' },
  { time: '12:00 PM', block: 'Midday check' },
  { time: '1:00 PM', block: 'BUILD BLOCK' },
  { time: '3:00 PM', block: 'LEARN BLOCK' },
  { time: '5:00 PM', block: 'People / maintenance' },
  { time: '7:00 PM', block: 'One-hour care gate' },
  { time: '8:00 PM', block: 'Manifestation / unrestricted' },
  { time: '9:00 PM', block: 'Night review' },
  { time: '10:00 PM', block: 'Night protocol' },
];

function parseClock(label) {
  const m = String(label).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const mer = (m[3] || '').toUpperCase();
  if (mer === 'PM' && hour !== 12) hour += 12;
  if (mer === 'AM' && hour === 12) hour = 0;
  return hour * 60 + min;
}

// Parses the locked schedule out of wiki/cortana-routine.md so the command
// center and the routine file cannot drift apart. Falls back to the built-in
// table if the markdown shape ever changes.
function collectPulse(vaultRoot, registry) {
  const now = new Date();
  const raw = readText(path.join(vaultRoot, 'wiki', 'cortana-routine.md'));
  let schedule = [];
  if (raw) {
    for (const line of raw.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const time = cells[1];
      const block = cells[2];
      if (!time || !block || /^-+$/.test(time) || /^time$/i.test(time)) continue;
      if (parseClock(time) === null) continue;
      schedule.push({ time, block, detail: cells[3] || '' });
    }
  }
  const source = schedule.length ? 'wiki/cortana-routine.md' : 'built-in fallback';
  if (!schedule.length) schedule = FALLBACK_SCHEDULE.map((s) => ({ ...s, detail: '' }));

  const minutes = now.getHours() * 60 + now.getMinutes();
  let current = null;
  let next = null;
  for (const item of schedule) {
    const at = parseClock(item.time);
    if (at === null) continue;
    if (at <= minutes) current = item;
    else if (!next) next = item;
  }

  const t = registry.targets || {};
  const rb = t.revenue_block || {};
  const rbStart = parseClock(rb.start || '9:30 AM') ?? 570;
  const rbEnd = parseClock(rb.end || '12:00 PM') ?? 720;

  return {
    status: 'ok',
    schedule_source: source,
    now: now.toISOString(),
    date: localDateKey(now),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    current_block: current,
    next_block: next,
    in_revenue_block: minutes >= rbStart && minutes < rbEnd,
    revenue_block: { start: rb.start || '09:30', end: rb.end || '12:00' },
    // Verified daily by Thomas, not by this server — reported as unknown, never assumed.
    non_negotiables: [
      { id: 'jog', label: 'Morning jog', state: 'unknown' },
      { id: 'calls', label: `${t.calls_per_day || 20} calls`, state: 'see outreach' },
      { id: 'night-release', label: 'Night release', state: 'unknown' },
    ],
  };
}

function collectOutreach(vaultRoot, registry) {
  const targets = registry.targets || {};
  const log = loadOutreachLog(vaultRoot);
  const today = localDateKey();
  const entry = (log.days || {})[today] || { calls: 0, emails: 0, notes: [] };
  const callTarget = Number(targets.calls_per_day) || 20;
  const emailTarget = Number(targets.emails_per_day) || 15;

  // Last 7 days, oldest first, for the trend strip.
  const recent = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    const day = (log.days || {})[key] || {};
    recent.push({ date: key, calls: Number(day.calls) || 0, emails: Number(day.emails) || 0, logged: !!(log.days || {})[key] });
  }
  const loggedDays = recent.filter((d) => d.logged).length;

  return {
    status: 'ok',
    today: {
      date: today,
      calls: Number(entry.calls) || 0,
      emails: Number(entry.emails) || 0,
      call_target: callTarget,
      email_target: emailTarget,
      calls_remaining: Math.max(0, callTarget - (Number(entry.calls) || 0)),
      emails_remaining: Math.max(0, emailTarget - (Number(entry.emails) || 0)),
      notes: Array.isArray(entry.notes) ? entry.notes.slice(-5) : [],
      logged_today: !!(log.days || {})[today],
    },
    last_7_days: recent,
    // A zero here means "nobody logged it", not "no calls were made". Say so.
    coverage_warning: loggedDays === 0
      ? 'No outreach has been logged in 7 days. These counts are blank, not zero.'
      : (loggedDays < 4 ? `Only ${loggedDays} of the last 7 days were logged.` : null),
    log_file: 'FGA-AIOS/command-center/outreach-log.json',
  };
}

function collectMoney(vaultRoot, registry, deps) {
  const out = { status: 'ok' };
  try { out.goals = planning.getGoals(vaultRoot, registry.targets || {}); }
  catch (err) { out.goals_error = err.message; out.status = 'degraded'; }
  try {
    out.api_spend = deps.spendSummary ? deps.spendSummary() : null;
  } catch (err) {
    out.api_spend = null;
    out.api_spend_error = String(err.message || err);
  }

  const businesses = registry.businesses || [];
  const confirmed = businesses.filter((b) => b.revenue_status === 'CONFIRMED' && typeof b.monthly_revenue_usd === 'number' && Number.isFinite(b.monthly_revenue_usd) && b.monthly_revenue_usd >= 0);
  const unconfirmed = businesses.filter((b) => b.kind !== 'prospect' && b.revenue_status !== 'CONFIRMED');
  const mrr = confirmed.reduce((sum, b) => sum + Number(b.monthly_revenue_usd), 0);
  const goal = registry.targets && registry.targets.target_month
    ? (out.goals ? out.goals.mrr_goal_usd : null)
    : Number((registry.targets || {}).mrr_goal_usd) || null;

  out.mrr = {
    confirmed_usd: mrr,
    goal_usd: goal,
    gap_usd: goal ? Math.max(0, goal - mrr) : null,
    confirmed_sources: confirmed.map((b) => ({ id: b.id, name: b.name, usd: Number(b.monthly_revenue_usd) })),
    unconfirmed_count: unconfirmed.length,
    unconfirmed: unconfirmed.map((b) => ({ id: b.id, name: b.name })),
    warning: unconfirmed.length
      ? `${unconfirmed.length} business${unconfirmed.length === 1 ? '' : 'es'} have UNCONFIRMED revenue. This MRR is a floor, not the real number.`
      : null,
  };
  return out;
}

function collectInbox(registry, deps) {
  if (!deps.runGws) return { status: 'unconfigured', error: 'no gws bridge available', buckets: [] };
  const queries = registry.inbox_queries || [];
  const results = [];
  let failures = 0;

  for (const q of queries) {
    const listOut = deps.runGws(['gmail', 'users', 'messages', 'list', '--params',
      JSON.stringify({ userId: 'me', q: String(q.query || ''), maxResults: 5 })]);
    const parsed = parseJsonOutput(listOut);
    if (!parsed.ok) {
      failures += 1;
      results.push({ ...q, status: 'error', error: parsed.error.slice(0, 300), count: null, messages: [] });
      continue;
    }
    const ids = parsed.data.messages || [];
    const messages = [];
    for (const m of ids.slice(0, 5)) {
      const msgOut = deps.runGws(['gmail', 'users', 'messages', 'get', '--params',
        JSON.stringify({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })]);
      const msgParsed = parseJsonOutput(msgOut);
      if (!msgParsed.ok) { messages.push({ id: m.id, error: 'metadata unavailable' }); continue; }
      const headers = {};
      ((msgParsed.data.payload || {}).headers || []).forEach((h) => { headers[h.name] = h.value; });
      messages.push({
        id: m.id,
        subject: headers.Subject || '(no subject)',
        from: headers.From || '',
        date: headers.Date || '',
        snippet: (msgParsed.data.snippet || '').slice(0, 180),
        url: `https://mail.google.com/mail/u/0/#inbox/${m.id}`,
      });
    }
    results.push({
      ...q,
      status: 'ok',
      // resultSizeEstimate is Gmail's own estimate; the exact count is only
      // known when it is under the page size, so both are reported.
      count: typeof parsed.data.resultSizeEstimate === 'number' ? parsed.data.resultSizeEstimate : ids.length,
      count_is_estimate: ids.length >= 5,
      messages,
    });
  }

  const status = !queries.length ? 'unconfigured'
    : failures === queries.length ? 'error'
      : failures ? 'degraded' : 'ok';
  return {
    status,
    error: status === 'error' ? (results[0] && results[0].error) || 'all Gmail queries failed' : undefined,
    account: 'thomasg@forevergoldai.com',
    buckets: results,
  };
}

function collectCalendar(deps) {
  if (!deps.runGws) return { status: 'unconfigured', error: 'no gws bridge available', today: [], upcoming: [] };
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 86400000);
  const out = deps.runGws(['calendar', 'events', 'list', '--params', JSON.stringify({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: weekOut.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 25,
  })]);
  const parsed = parseJsonOutput(out);
  if (!parsed.ok) return { status: 'error', error: parsed.error.slice(0, 300), today: [], upcoming: [] };

  const todayKey = localDateKey(now);
  const events = (parsed.data.items || []).map((e) => {
    const startRaw = (e.start || {}).dateTime || (e.start || {}).date || '';
    const allDay = !(e.start || {}).dateTime;
    const startDate = startRaw ? new Date(startRaw) : null;
    return {
      id: e.id,
      summary: e.summary || '(untitled)',
      start: startRaw,
      all_day: allDay,
      day: startDate ? localDateKey(startDate) : '',
      time: startDate && !allDay ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'All day',
      location: e.location || '',
      url: e.htmlLink || '',
    };
  });

  return {
    status: 'ok',
    today: events.filter((e) => e.day === todayKey),
    upcoming: events.filter((e) => e.day !== todayKey),
  };
}

// Reads the usability of a three-Ps file, not merely its existence.
//   missing    — no file at all
//   blank      — file exists but has effectively no content
//   unverified — one or more of Pain/Person/Promise is an UNVERIFIED placeholder
//   present    — all three carry real, human-confirmed content
// Only 'present' clears a business to have creative generated for it.
function threePsState(raw) {
  if (!raw) return { state: 'missing', unverified: [] };
  const body = raw.replace(/^---[\s\S]*?---/, '');
  if (body.replace(/[#\s>*_-]/g, '').length < 60) return { state: 'blank', unverified: [] };

  // Split the document into heading-delimited sections first, then look each P
  // up. A per-key regex is the wrong tool here twice over: the headings carry a
  // trailing gloss ("## Pain — what this business actually solves"), and a
  // multiline `$` end-anchor silently truncates a section to its first line —
  // which hides an UNVERIFIED marker sitting on line three, as GMM's does.
  const sections = new Map();
  let currentKey = null;
  const buffer = [];
  const flush = () => { if (currentKey) sections.set(currentKey, buffer.join('\n')); buffer.length = 0; };
  for (const line of body.split('\n')) {
    const heading = line.match(/^#{1,6}[ \t]+(.*)$/);
    if (heading) {
      flush();
      // "Pain — what this business actually solves" keys on its first word.
      currentKey = heading[1].trim().split(/[\s—–:-]+/)[0].toLowerCase();
      continue;
    }
    if (currentKey) buffer.push(line);
  }
  flush();

  const unverified = [];
  for (const key of ['Pain', 'Person', 'Promise']) {
    const text = sections.get(key.toLowerCase());
    if (text == null) { unverified.push(key); continue; }
    if (text.replace(/[#\s>*_-]/g, '').length < 20) { unverified.push(key); continue; }
    if (/UNVERIFIED|UNCONFIRMED|\bTBD\b|\bTODO\b|needs (Thomas|confirmation|[A-Z][a-z]+'s confirmation)/i.test(text)) unverified.push(key);
  }
  return unverified.length ? { state: 'unverified', unverified } : { state: 'present', unverified: [] };
}

function collectClients(vaultRoot, registry) {
  const businesses = (registry.businesses || []).map((b) => {
    const dir = b.vault ? path.join(vaultRoot, b.vault) : null;
    const exists = dir ? fs.existsSync(dir) : false;
    const threePsFile = dir ? path.join(dir, 'context', 'three-ps.md') : null;
    const threePsRaw = threePsFile && fs.existsSync(threePsFile) ? readText(threePsFile) : null;
    const threePs = threePsState(threePsRaw);
    return {
      ...b,
      vault_exists: exists,
      vault_missing: !!(b.vault && !exists),
      last_touched: exists ? newestMtime(dir) : null,
      // Marketing gate. Length alone is not enough: Cosmic Gold's file is over
      // a kilobyte of prose explaining why its Pain/Person/Promise are still
      // UNVERIFIED. Reading that as "present" would green-light exactly the
      // fabricated creative the three-Ps rule exists to prevent.
      three_ps: threePs.state,
      // Which of Pain/Person/Promise still needs a human — the actionable half.
      three_ps_unverified: threePs.unverified,
    };
  });

  const order = { 'active-paying': 0, 'active-delivery': 1, 'active-decision-pending': 2, active: 3, 'active-early': 4, stalled: 5, delivered: 6 };
  businesses.sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99)
    || (order[a.status] ?? 9) - (order[b.status] ?? 9));

  return {
    status: registry.__error ? 'error' : 'ok',
    error: registry.__error,
    clients: businesses.filter((b) => b.kind === 'client'),
    owned: businesses.filter((b) => b.kind === 'owned'),
    prospects: businesses.filter((b) => b.kind === 'prospect'),
    counts: {
      clients: businesses.filter((b) => b.kind === 'client').length,
      owned: businesses.filter((b) => b.kind === 'owned').length,
      prospects: businesses.filter((b) => b.kind === 'prospect').length,
      paying: businesses.filter((b) => b.status === 'active-paying').length,
    },
  };
}

async function probeUrl(url, timeoutMs = 8000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GET, not HEAD: GitHub Pages and Workers both answer HEAD inconsistently.
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    // Drain so the socket closes rather than leaking into the next probe.
    await res.text().catch(() => '');
    return { http_status: res.status, ok: res.status >= 200 && res.status < 400, ms: Date.now() - started };
  } catch (err) {
    return { http_status: null, ok: false, ms: Date.now() - started, error: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function collectPages(registry) {
  const pages = registry.pages || [];
  const backends = registry.backends || [];
  const all = [
    ...pages.map((p) => ({ ...p, group: 'page' })),
    ...backends.map((b) => ({ ...b, group: 'backend', kind: 'backend' })),
  ];
  if (!all.length) return { status: 'unconfigured', error: 'no pages in registry', pages: [], backends: [], bubbles: [], down: [] };

  // Bubbles = one box per business, so a client's whole surface area reads as a
  // unit instead of a flat list. `group` above is already taken (page/backend),
  // hence `bubble`. A page falls into its business unless it overrides with
  // `bubble` — Cortana does, because it is infrastructure, not a Forever Gold
  // customer-facing asset, and lumping it in there misreads the board.
  const groupDefs = Array.isArray(registry.page_groups) ? registry.page_groups : [];
  const labelOf = new Map(groupDefs.map((g) => [g.id, g.label]));
  const orderOf = new Map(groupDefs.map((g, i) => [g.id, i]));

  const probed = await Promise.all(all.map(async (item) => {
    const health = await probeUrl(item.url);
    const expected = item.expect_status;
    const ok = Number.isFinite(expected) ? health.http_status === expected : health.ok;
    const bubble = item.bubble || item.business || 'other';
    return { ...item, ...health, ok, bubble, bubble_label: labelOf.get(bubble) || 'Other' };
  }));

  const byBubble = new Map();
  for (const item of probed) {
    if (!byBubble.has(item.bubble)) byBubble.set(item.bubble, { id: item.bubble, label: item.bubble_label, items: [] });
    byBubble.get(item.bubble).items.push(item);
  }
  // Declared order first, in registry order; anything undeclared sorts to the
  // end alphabetically rather than vanishing — a new URL shows up even if
  // someone forgets to declare its bubble.
  const bubbles = [...byBubble.values()]
    .map((g) => ({ ...g, down: g.items.filter((x) => !x.ok).length, critical_down: g.items.filter((x) => !x.ok && x.critical).length }))
    .sort((a, b) => (orderOf.has(a.id) ? orderOf.get(a.id) : 999) - (orderOf.has(b.id) ? orderOf.get(b.id) : 999)
      || String(a.label).localeCompare(String(b.label)));

  const down = probed.filter((p) => !p.ok);
  return {
    status: down.length === 0 ? 'ok' : (down.some((p) => p.critical) ? 'error' : 'degraded'),
    error: down.length ? `${down.length} endpoint${down.length === 1 ? '' : 's'} not answering` : undefined,
    checked_at: new Date().toISOString(),
    pages: probed.filter((p) => p.group === 'page'),
    backends: probed.filter((p) => p.group === 'backend'),
    bubbles,
    down: down.map((p) => ({ id: p.id, label: p.label, url: p.url, http_status: p.http_status, error: p.error, critical: !!p.critical })),
  };
}

function collectProjects(vaultRoot, registry) {
  const work = planning.getWork(vaultRoot);
  const projects = work.projects.filter(p => p.state !== 'done').sort((a,b)=>(a.priority ?? 999)-(b.priority ?? 999)).map((p) => {
    const dir = p.vault ? path.join(vaultRoot, p.vault) : null;
    return {
      ...p,
      vault_exists: dir ? fs.existsSync(dir) : null,
      last_touched: dir && fs.existsSync(dir) ? newestMtime(dir) : null,
    };
  });
  return {
    status: 'ok',
    work_revision: work.revision,
    day: work.day,
    blocked: projects.filter((p) => p.state === 'blocked'),
    open: projects.filter((p) => p.state === 'open' || p.state === 'in_progress'),
    other: projects.filter((p) => !['blocked','open','in_progress'].includes(p.state)),
    // Anything waiting on Thomas is the whole point of surfacing this card.
    waiting_on_thomas: projects.filter((p) => p.lane === 'thomas' && p.state !== 'paused'),
  };
}

// Minimal RFC4180-ish CSV row splitter — the generation log has quoted commas
// in its notes column, so a naive split() loses columns.
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function collectMarketing(vaultRoot, registry) {
  const rel = (registry.marketing || {}).generation_log || 'FGA-AIOS/marketing/generation-log.csv';
  const file = path.join(vaultRoot, rel);
  const raw = readText(file);
  if (!raw) {
    return {
      status: 'error',
      error: `generation log not readable at ${rel}`,
      log_file: rel,
      totals: { runs: 0, usd: 0, usd_unrecorded: 0 },
      by_status: {}, proven: [], recent: [],
    };
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { status: 'ok', runs: [], totals: { runs: 0, usd: 0, usd_unrecorded: 0 }, by_status: {} };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const runs = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const get = (name) => { const i = idx(name); return i >= 0 ? (cells[i] || '').trim() : ''; };
    const usdRaw = get('usd_cost');
    return {
      date: get('date'),
      business: get('business'),
      campaign: get('campaign'),
      channel: get('channel'),
      angle: get('primary_angle'),
      deliverables: get('deliverables'),
      status: get('status'),
      usd: usdRaw === '' || usdRaw.toUpperCase() === 'UNKNOWN' ? null : Number(usdRaw),
      output_path: get('output_path'),
    };
  });

  // Newest first, with undated/backfilled rows last rather than sorted wrongly.
  runs.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const byStatus = {};
  runs.forEach((r) => { const k = r.status || 'unlabelled'; byStatus[k] = (byStatus[k] || 0) + 1; });
  const withCost = runs.filter((r) => Number.isFinite(r.usd));

  return {
    status: 'ok',
    log_file: rel,
    totals: {
      runs: runs.length,
      usd: +withCost.reduce((s, r) => s + r.usd, 0).toFixed(2),
      // Real cost is required at log time; unrecorded rows are called out, not averaged over.
      usd_unrecorded: runs.length - withCost.length,
    },
    by_status: byStatus,
    proven: runs.filter((r) => /proven/i.test(r.status)).slice(0, 5),
    recent: runs.slice(0, 8),
  };
}

async function collectAutomations(deps) {
  if (!deps.n8nRequest) return { status: 'unconfigured', error: 'no n8n bridge available', counts: { total: 0, active: 0 }, workflows: [], recent_failures: [] };

  const listRaw = await deps.n8nRequest('GET', '/workflows?limit=100');
  const list = parseJsonOutput(listRaw);
  if (!list.ok) {
    return {
      status: 'error',
      error: list.error.slice(0, 300),
      // The known lockout mode: quota exhaustion returns a 4xx on every call.
      hint: /quota|limit|402|403/i.test(list.error) ? 'Looks like the account-wide execution quota lockout. Check for an orphaned polling workflow.' : undefined,
      workflows: [], recent_failures: [],
    };
  }

  const workflows = (list.data.data || []).map((w) => ({
    id: w.id,
    name: w.name,
    active: !!w.active,
    updated_at: w.updatedAt || null,
  })).sort((a, b) => Number(b.active) - Number(a.active) || String(a.name).localeCompare(String(b.name)));

  let failures = [];
  let execError = null;
  const execRaw = await deps.n8nRequest('GET', '/executions?limit=20&status=error');
  const execs = parseJsonOutput(execRaw);
  if (execs.ok) {
    failures = (execs.data.data || []).map((e) => ({
      id: e.id,
      workflow_id: e.workflowId,
      workflow_name: (workflows.find((w) => String(w.id) === String(e.workflowId)) || {}).name || e.workflowId,
      started_at: e.startedAt || null,
      status: e.status || 'error',
    }));
  } else {
    execError = execs.error.slice(0, 200);
  }

  return {
    status: execError ? 'degraded' : 'ok',
    error: execError,
    counts: { total: workflows.length, active: workflows.filter((w) => w.active).length },
    workflows,
    recent_failures: failures,
  };
}

function collectTasks(deps) {
  if (!deps.loadTaskBoard) return { status: 'unconfigured', error: 'no task board available', counts: {}, todo: [], in_progress: [], done_recent: [] };
  const board = deps.loadTaskBoard();
  const columns = board.columns || {};
  return {
    status: 'ok',
    updated_at: board.updated_at || null,
    counts: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, (v || []).length])),
    todo: (columns.todo || []).slice(0, 10),
    in_progress: (columns.in_progress || []).slice(0, 10),
    done_recent: (columns.done || []).slice(-5).reverse(),
  };
}

// Enforces the CLAUDE.md rule that a day must not pass with only a mindset note
// and no real activity — the command center is where that gap gets seen.
function collectJournal(vaultRoot) {
  const dir = path.join(vaultRoot, 'wiki', 'conversations');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  } catch (err) {
    return { status: 'error', error: `conversations folder unreadable: ${err.message}` };
  }
  const today = localDateKey();
  const todayFile = path.join(dir, `${today}.md`);
  const todayRaw = readText(todayFile);
  const yesterday = localDateKey(new Date(Date.now() - 86400000));

  return {
    status: 'ok',
    today: {
      date: today,
      exists: !!todayRaw,
      chars: todayRaw ? todayRaw.length : 0,
      // Under ~400 chars is a stub, not a day's record.
      looks_empty: !todayRaw || todayRaw.replace(/^---[\s\S]*?---/, '').trim().length < 400,
    },
    yesterday: { date: yesterday, exists: files.includes(`${yesterday}.md`) },
    latest_logged: files[0] ? files[0].replace('.md', '') : null,
    days_since_last_log: files[0] ? Math.max(0, Math.round((Date.parse(today) - Date.parse(files[0].replace('.md', ''))) / 86400000)) : null,
    recent: files.slice(0, 7).map((f) => ({ date: f.replace('.md', ''), age_days: fileAgeDays(path.join(dir, f)) })),
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Build the aggregated command-center payload.
 *
 * @param {object} deps  { vaultRoot, runGws?, n8nRequest?, spendSummary?, loadTaskBoard? }
 * @param {object} opts  { sections?: string[], refresh?: boolean }
 */
async function buildCommandCenter(deps = {}, opts = {}) {
  const vaultRoot = deps.vaultRoot;
  if (!vaultRoot) throw new Error('buildCommandCenter requires deps.vaultRoot');

  const wanted = Array.isArray(opts.sections) && opts.sections.length
    ? SECTIONS.filter((s) => opts.sections.includes(s))
    : SECTIONS;
  const refresh = !!opts.refresh;
  const registry = loadRegistry(vaultRoot);
  const started = Date.now();

  const producers = {
    pulse: () => collectPulse(vaultRoot, registry),
    outreach: () => collectOutreach(vaultRoot, registry),
    money: () => collectMoney(vaultRoot, registry, deps),
    inbox: () => collectInbox(registry, deps),
    calendar: () => collectCalendar(deps),
    clients: () => collectClients(vaultRoot, registry),
    pages: () => collectPages(registry),
    projects: () => collectProjects(vaultRoot, registry),
    marketing: () => collectMarketing(vaultRoot, registry),
    automations: () => collectAutomations(deps),
    tasks: () => collectTasks(deps),
    journal: () => collectJournal(vaultRoot),
  };

  const settled = await Promise.allSettled(
    wanted.map((name) => cached(name, refresh, producers[name]))
  );

  const sections = {};
  wanted.forEach((name, i) => {
    const r = settled[i];
    sections[name] = r.status === 'fulfilled'
      ? r.value
      : { status: 'error', error: String((r.reason && r.reason.message) || r.reason) };
  });

  // One roll-up line so the page (and Cortana in chat) can lead with what is
  // actually wrong instead of making the reader scan twelve cards.
  const alerts = [];
  if (sections.pages && Array.isArray(sections.pages.down)) {
    sections.pages.down.filter((d) => d.critical).forEach((d) => alerts.push({ level: 'critical', source: 'pages', message: `${d.label} is not answering (${d.http_status || d.error})` }));
  }
  if (sections.automations && sections.automations.status === 'error') {
    alerts.push({ level: 'critical', source: 'automations', message: `n8n unreachable: ${sections.automations.error}` });
  }
  if (sections.automations && (sections.automations.recent_failures || []).length) {
    alerts.push({ level: 'warn', source: 'automations', message: `${sections.automations.recent_failures.length} failed n8n execution(s) recently` });
  }
  if (sections.projects && (sections.projects.waiting_on_thomas || []).length) {
    alerts.push({ level: 'warn', source: 'projects', message: `${sections.projects.waiting_on_thomas.length} project(s) blocked waiting on you` });
  }
  if (sections.outreach && sections.outreach.coverage_warning) {
    alerts.push({ level: 'warn', source: 'outreach', message: sections.outreach.coverage_warning });
  }
  if (sections.journal && sections.journal.today && sections.journal.today.looks_empty) {
    alerts.push({ level: 'info', source: 'journal', message: `Activity log for ${sections.journal.today.date} is still empty.` });
  }
  if (sections.inbox && sections.inbox.status === 'error') {
    alerts.push({ level: 'warn', source: 'inbox', message: `Gmail unreachable: ${sections.inbox.error}` });
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    build_ms: Date.now() - started,
    registry_updated: registry.updated || null,
    registry_error: registry.__error || null,
    alerts,
    sections,
  };
}

module.exports = {
  buildCommandCenter,
  recordOutreach,
  loadRegistry,
  loadOutreachLog,
  invalidateCache,
  SECTIONS,
  // exported for tests
  _internals: { splitCsvLine, parseClock, threePsState, collectPulse, collectOutreach, collectMarketing, collectClients, collectJournal, isToolError },
};
