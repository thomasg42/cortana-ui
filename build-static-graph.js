// Refresh the public GitHub Pages graph snapshot from the running local Cortana core.
// The public Galaxy shows the complete vault topology (every note and connection),
// but only explicitly public-safe Build and Learning notes expose their real title,
// path, and excerpt. All other nodes are represented by anonymous stable stars.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

const target = path.join(__dirname, 'graph-data.js');
const coreUrl = new URL(process.env.CORTANA_CORE_URL || 'http://127.0.0.1:3000');
coreUrl.pathname = '/api/graph';
coreUrl.search = '?refresh=1';

// server.js refuses direct loopback hits by default (see CORE LINK auth
// gate) — this internal build script authenticates as itself with the same
// per-install secret server.js already uses, rather than needing the local
// UI opened up.
const remoteAccessFile = path.join(__dirname, '..', 'private', 'cortana', 'remote-access.json');
let buildKey = '';
try { buildKey = JSON.parse(fs.readFileSync(remoteAccessFile, 'utf-8')).tokenSecret || ''; } catch (_) { /* server has never run yet */ }
const PUBLIC_PREFIXES = ['wiki/builds/', 'wiki/learning/'];

const isPublic = (node) => PUBLIC_PREFIXES.some((prefix) =>
  String(node.path || '').startsWith(prefix)
);

const safeSlug = (value) => String(value || 'vault')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'vault';

const pretty = (value) => String(value || 'vault')
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

/* The Galaxy outline shows a one-line gist under every note. galaxy.js derives
   that from the excerpt, but a knowledge-base page spends its first 500 chars
   on its own title plus a FOLDER/DESTINATION-ID header, pushing the one line
   worth reading — the source video's title — past the published excerpt. Lift
   just that line here, where the core's full excerpt is in hand, instead of
   publishing 200 more characters of every note to reach it: raw excerpt text
   is exactly where a pasted .env sample or key-shaped string would ride along.
   Everything else (prose gists, redacted nodes) stays in galaxy.js. */
const KB_FIELD = /(?:^|\s)(?:VIDEO|DOCUMENT|DESTINATION|KNOWLEDGE|FOLDER|CHANNEL|CREATOR|SOURCE|CATEGORY|HANDLE|STATUS|TAGS|DATE|URL|LINK|CAPTURED|CREATED|UPDATED|OWNER)\b[A-Z0-9 ]*:/;
const normKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function ideaField(node) {
  const raw = String(node.excerpt || '').replace(/\s+/g, ' ').trim();
  const label = String(node.label || '');
  const match = raw.match(/\b(?:VIDEO|DOCUMENT)\s+TITLE:\s*(\S.*)$/)
    || raw.match(/\bSource video:\s*(\S.*)$/i);
  if (!match) return {};
  const stop = match[1].search(KB_FIELD);
  const value = (stop > 0 ? match[1].slice(0, stop) : match[1])
    .replace(/\s*\(YouTube\)\s*$/i, '')
    .trim()
    .slice(0, 160);
  // Skip anything that just repeats the note's own title, or that still looks
  // like a credential line rather than a title.
  if (value.length < 9 || /^https?:/i.test(value)) return {};
  if (/[A-Z_]{4,}\s*[=:]\s*\S/.test(value)) return {};
  if (normKey(value).startsWith(normKey(label).slice(0, 24))) return {};
  return { idea: value };
}

function publicSnapshot(graph) {
  const sourceNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const sourceLinks = Array.isArray(graph.links) ? graph.links : [];
  const idMap = new Map(sourceNodes.map((node, index) => [node.id, index]));
  const ordinals = new Map();
  const privatePaths = sourceNodes
    .filter((node) => !isPublic(node) && node.path)
    .map((node) => String(node.path))
    .sort((a, b) => b.length - a.length);
  const redactPrivatePathReferences = (value) => {
    let safe = String(value || '');
    for (const privatePath of privatePaths) {
      safe = safe.split(privatePath).join('[private vault path]');
    }
    return safe;
  };

  const nodes = sourceNodes.map((node, index) => {
    const group = String(node.group || 'vault');
    // Year/YouTube/Business/Class are classification metadata, not content —
    // same sensitivity tier as `group`, which already passes through
    // unredacted below. Carrying them through keeps the topic drill-down
    // useful on the public snapshot instead of dumping every node into one
    // undifferentiated "Unclassified" bucket.
    const dimensions = {
      year: node.year || 'Unclassified',
      youtube: node.youtube || null,
      business: node.business || null,
      class: node.class || group,
    };

    if (isPublic(node)) {
      return {
        id: index,
        path: String(node.path || ''),
        label: String(node.label || 'Untitled note'),
        group,
        excerpt: redactPrivatePathReferences(node.excerpt).slice(0, 500),
        ...ideaField(node),
        redacted: false,
        // Only a public node's real folder ships. A private node's folder name
        // IS private content — "Cars/1985-1986 BMW E30" describes the vault as
        // plainly as its excerpt would — so redacted nodes below get none.
        folder: String(node.folder || ''),
        modified: node.modified || null,
        ...dimensions,
      };
    }

    const ordinal = (ordinals.get(group) || 0) + 1;
    ordinals.set(group, ordinal);
    const token = crypto.createHash('sha256')
      .update(`${node.path || node.id || index}|cortana-public-topology-v1`)
      .digest('hex')
      .slice(0, 12);
    return {
      id: index,
      path: `redacted/${safeSlug(group)}/${token}`,
      label: `Private ${pretty(group)} node ${String(ordinal).padStart(3, '0')}`,
      group,
      excerpt: 'Private topology node. Open Cortana on the local FGA-Brain core to inspect this note.',
      redacted: true,
      folder: `redacted/${safeSlug(group)}`,
      modified: null,
      ...dimensions,
    };
  });

  const links = sourceLinks
    .filter((link) => idMap.has(link.source) && idMap.has(link.target))
    .map((link) => ({
      source: idMap.get(link.source),
      target: idMap.get(link.target),
      kind: String(link.kind || 'related'),
    }));

  const groups = [...new Set(nodes.map((node) => node.group).filter(Boolean))];
  const groupCounts = Object.fromEntries(groups.map((group) => [
    group,
    nodes.filter((node) => node.group === group).length,
  ]));

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    links,
    groups,
    groupCounts,
    noteCount: nodes.length,
    publicSnapshot: true,
    snapshotScope: {
      topology: 'all vault notes and links',
      readablePrefixes: [...PUBLIC_PREFIXES],
      privateContent: 'redacted',
    },
  };
}

http.get(coreUrl, { headers: { 'x-cortana-build-key': buildKey } }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    if (res.statusCode !== 200) throw new Error(`Graph endpoint returned ${res.statusCode}`);
    const graph = publicSnapshot(JSON.parse(body));
    const output = `// Generated by build-static-graph.js — full topology, private content redacted.\nwindow.CORTANA_STATIC_GRAPH = ${JSON.stringify(graph)};\n`;
    fs.writeFileSync(target, output, 'utf8');
    console.log(`Wrote ${target}: ${graph.noteCount} notes, ${graph.links.length} links, ${graph.groups.length} groups`);
  });
}).on('error', (err) => {
  console.error(`Could not reach local Cortana core: ${err.message}`);
  process.exitCode = 1;
});
