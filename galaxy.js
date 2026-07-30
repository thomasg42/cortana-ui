(() => {
  'use strict';

  const COLORS = [
    0xffc42e, 0xff6a32, 0x5edbff, 0xc989ff,
    0x65f2a5, 0xff78c7, 0x8da2ff, 0xffef9d,
    0x55efe7, 0xff5252, 0x95e85f, 0xd6a85f,
    0x7bd0ff, 0xe4e9ff, 0xb6ff57, 0xff9e72,
  ];
  const STAR_COLOR = new THREE.Color(0xffc42e);
  let graphData = null;
  let galaxy = null;
  let points = null;
  let linkLines = null;
  let haloWorld = null;
  let nodePositions = [];
  let nodeColors = null;
  let baseColors = [];
  let raycaster = null;
  let pointer = new THREE.Vector2();
  let hovered = null;
  let activeNode = null;
  let targetCamera = new THREE.Vector3(0, 0, 10.5);
  let lookTarget = new THREE.Vector3(0, 0.2, 0);
  let targetLook = new THREE.Vector3(0, 0.2, 0);
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let rotationStart = { x: 0, y: 0 };
  let lastInteraction = Date.now();
  let booted = false;

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const rand = (seed) => {
    const x = Math.sin(seed * 999.91) * 43758.5453;
    return x - Math.floor(x);
  };
  const cssHex = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

  function buildChrome() {
    const view = document.createElement('div');
    view.id = 'viewSwitch';
    view.innerHTML = '<button class="viewBtn" data-view="core">Core</button><button class="viewBtn" data-view="galaxy">Galaxy</button>';
    document.body.appendChild(view);

    const meta = document.createElement('div');
    meta.id = 'galaxyMeta';
    meta.textContent = 'Indexing FGA-Brain…';
    document.body.appendChild(meta);

    const rail = document.createElement('div');
    rail.id = 'dayRail';
    document.body.appendChild(rail);

    const legend = document.createElement('div');
    legend.id = 'galaxyLegend';
    document.body.appendChild(legend);

    const hint = document.createElement('div');
    hint.id = 'galaxyHint';
    hint.textContent = 'drag to orbit  ·  scroll to travel  ·  select a star to open its note';
    document.body.appendChild(hint);

    const source = document.createElement('aside');
    source.id = 'sourceCard';
    source.innerHTML = '<div class="sourceEyebrow">Source node</div><div class="sourceTitle"></div><div class="sourcePath"></div><div class="sourceExcerpt"></div><div class="sourceActions"><button data-action="open">Open note</button><button data-action="context">+ Context</button></div>';
    document.body.appendChild(source);

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) setView(btn.dataset.view);
    });
    source.querySelector('[data-action="open"]').addEventListener('click', () => activeNode && !activeNode.redacted && openFile(activeNode.path));
    source.querySelector('[data-action="context"]').addEventListener('click', () => {
      if (activeNode && !activeNode.redacted && !contextFiles.includes(activeNode.path)) { contextFiles.push(activeNode.path); renderChips(); }
      source.classList.remove('open');
    });
    renderDayRail();
    setInterval(renderDayRail, 60 * 1000);
  }

  function renderDayRail() {
    const blocks = [
      [8, '8:00', 'Ground'], [8.25, '8:15', 'Jog'], [9.5, '9:30', 'Revenue'],
      [13, '1:00', 'Build'], [15, '3:00', 'Learn'], [17, '5:00', 'People'], [19, '7:00', 'Off'],
    ];
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    let active = 0;
    blocks.forEach((b, i) => { if (hour >= b[0]) active = i; });
    const rail = document.getElementById('dayRail');
    rail.innerHTML = blocks.map((b, i) => `<div class="dayBlock ${i < active ? 'done' : ''} ${i === active ? 'active' : ''}"><span class="dt">${b[1]}</span>${b[2]}</div>`).join('');
  }

  function spriteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(.12, 'rgba(255,255,255,1)');
    g.addColorStop(.32, 'rgba(255,255,255,.72)');
    g.addColorStop(.62, 'rgba(255,255,255,.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  function starfield() {
    const count = 1000;
    const pos = [];
    for (let i = 0; i < count; i++) {
      const r = 18 + Math.random() * 28;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffc8a0, size: .045, transparent: true, opacity: .48, depthWrite: false }));
  }

  function finishHaloTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy
      ? Math.min(16, renderer.capabilities.getMaxAnisotropy())
      : 1;
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    return tex;
  }

  /* Inner habitable surface — a sharp 4K map with hard coastlines, terrain
     ridges, rivers, ice, cloud lanes, and distinct retaining-wall shadows. */
  function haloTerrainTexture() {
    const W = 4096, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const sea = ctx.createLinearGradient(0, 0, 0, H);
    sea.addColorStop(0, '#111b24'); sea.addColorStop(.09, '#183849');
    sea.addColorStop(.24, '#17627f'); sea.addColorStop(.5, '#237fa2');
    sea.addColorStop(.76, '#17627f'); sea.addColorStop(.91, '#183849');
    sea.addColorStop(1, '#111b24');
    ctx.fillStyle = sea; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(170,225,250,.08)';
    ctx.lineWidth = 1;
    for (let y = 64; y < H - 64; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    let s = 7;
    const rnd = () => rand(s++);
    const drawPolygon = (points, off, fill, stroke, width = 2) => {
      ctx.beginPath();
      ctx.moveTo(points[0][0] + off, points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] + off, points[i][1]);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke();
    };

    const LAND = ['#355b38', '#3f7041', '#607340', '#756e3e', '#8a7947'];
    for (let i = 0; i < 36; i++) {
      const cx = rnd() * W, cy = 76 + rnd() * (H - 152);
      const rx = 48 + rnd() * 150, ry = 24 + rnd() * 72;
      const points = [];
      const count = 22 + Math.floor(rnd() * 12);
      for (let p = 0; p < count; p++) {
        const a = p / count * Math.PI * 2;
        const rough = .72 + rnd() * .42;
        points.push([cx + Math.cos(a) * rx * rough, cy + Math.sin(a) * ry * rough]);
      }
      const color = LAND[Math.floor(rnd() * LAND.length)];
      for (const off of [-W, 0, W]) {
        drawPolygon(points, off, color, 'rgba(183,203,137,.56)', 2.2);
        ctx.strokeStyle = 'rgba(28,52,31,.72)'; ctx.lineWidth = 1.2;
        for (let ridge = 0; ridge < 5; ridge++) {
          const yy = cy + (ridge - 2) * ry * .22;
          ctx.beginPath();
          ctx.moveTo(cx - rx * .62 + off, yy);
          ctx.bezierCurveTo(cx - rx * .22 + off, yy - 18, cx + rx * .18 + off, yy + 20, cx + rx * .62 + off, yy - 4);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(134,211,238,.74)'; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx - rx * .12 + off, cy - ry * .6);
        ctx.bezierCurveTo(cx + rx * .08 + off, cy - ry * .15, cx - rx * .18 + off, cy + ry * .15, cx + rx * .25 + off, cy + ry * .62);
        ctx.stroke();
      }
    }

    for (let i = 0; i < 18; i++) {
      const cx = rnd() * W, top = rnd() < .5;
      const cy = top ? 50 + rnd() * 34 : H - 50 - rnd() * 34;
      const rx = 24 + rnd() * 58, ry = 8 + rnd() * 18;
      const points = [];
      for (let p = 0; p < 12; p++) {
        const a = p / 12 * Math.PI * 2;
        points.push([cx + Math.cos(a) * rx * (.74 + rnd() * .32), cy + Math.sin(a) * ry * (.74 + rnd() * .32)]);
      }
      for (const off of [-W, 0, W]) drawPolygon(points, off, '#d8e7ec', 'rgba(255,255,255,.72)', 1.5);
    }

    ctx.lineCap = 'round';
    for (let i = 0; i < 92; i++) {
      const px = rnd() * W, py = 40 + rnd() * (H - 80);
      const len = 40 + rnd() * 180, amp = 4 + rnd() * 18;
      ctx.globalAlpha = .18 + rnd() * .34;
      ctx.strokeStyle = '#eef9ff'; ctx.lineWidth = 2 + rnd() * 5;
      for (const off of [-W, 0, W]) {
        ctx.beginPath(); ctx.moveTo(px - len * .5 + off, py);
        ctx.bezierCurveTo(px - len * .18 + off, py - amp, px + len * .18 + off, py + amp, px + len * .5 + off, py);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.lineCap = 'butt';

    const atm = ctx.createLinearGradient(0, 0, 0, H);
    atm.addColorStop(0, 'rgba(5,10,16,.97)'); atm.addColorStop(.035, 'rgba(19,35,47,.92)');
    atm.addColorStop(.09, 'rgba(105,182,226,.26)'); atm.addColorStop(.16, 'rgba(105,182,226,.04)');
    atm.addColorStop(.5, 'rgba(255,255,255,0)');
    atm.addColorStop(.84, 'rgba(105,182,226,.04)'); atm.addColorStop(.91, 'rgba(105,182,226,.26)');
    atm.addColorStop(.965, 'rgba(19,35,47,.92)'); atm.addColorStop(1, 'rgba(5,10,16,.97)');
    ctx.fillStyle = atm; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(176,226,255,.72)';
    ctx.fillRect(0, 43, W, 2); ctx.fillRect(0, H - 45, W, 2);
    return finishHaloTexture(c);
  }

  /* Outer hull — a 4K hard-surface panel map with bevel lines, structural
     channels, center rails, and precise blue running lights. */
  function haloHullTexture() {
    const W = 4096, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#4b5661'); base.addColorStop(.08, '#26313b');
    base.addColorStop(.5, '#121b23'); base.addColorStop(.92, '#26313b'); base.addColorStop(1, '#4b5661');
    ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);

    const cols = 64, rows = 8, cellW = W / cols, cellH = H / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * cellW, y = row * cellH;
        const inset = 4 + ((row + col) % 3);
        ctx.fillStyle = (row + col) % 2 ? 'rgba(82,97,109,.24)' : 'rgba(7,13,19,.34)';
        ctx.fillRect(x + inset, y + 5, cellW - inset * 2, cellH - 10);
        ctx.strokeStyle = 'rgba(148,172,188,.28)'; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + inset, y + 5, cellW - inset * 2, cellH - 10);
        ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + inset, y + cellH - 6); ctx.lineTo(x + cellW - inset, y + cellH - 6); ctx.stroke();
      }
    }

    ctx.lineWidth = 3;
    for (let x = 0; x < W; x += 256) {
      ctx.strokeStyle = 'rgba(5,10,14,.92)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 70, H * .5); ctx.lineTo(x, H); ctx.stroke();
      ctx.strokeStyle = 'rgba(103,132,151,.34)';
      ctx.beginPath(); ctx.moveTo(x + 6, 0); ctx.lineTo(x + 76, H * .5); ctx.lineTo(x + 6, H); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(3,8,12,.9)'; ctx.fillRect(0, H * .46, W, H * .08);
    ctx.fillStyle = 'rgba(92,177,224,.34)'; ctx.fillRect(0, H * .495, W, 3);
    for (const y of [H * .2, H * .8]) {
      for (let x = 20; x < W; x += 72) {
        ctx.fillStyle = 'rgba(84,184,244,.22)'; ctx.fillRect(x - 5, y - 5, 18, 12);
        ctx.fillStyle = '#bceaff'; ctx.fillRect(x, y - 2, 8, 4);
      }
    }
    ctx.fillStyle = 'rgba(196,222,235,.58)';
    ctx.fillRect(0, 5, W, 2); ctx.fillRect(0, H - 7, W, 2);
    return finishHaloTexture(c);
  }

  /* The Ring itself — high-segment scene geometry with a readable terrain
     face, metallic shell, raised structural ribs, hard rim rails, and a thin
     atmosphere. Nothing is blurred into a generic glowing circle. */
  function buildHaloWorld() {
    const ring = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.x = Math.PI / 2;
    const spinner = new THREE.Group();
    tilt.add(spinner);
    ring.add(tilt);

    const R = 5.82, BAND = .88, HULL = .14, SEGMENTS = 768;
    const terrainTex = haloTerrainTexture();
    const hullTex = haloHullTexture();
    const terrain = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, BAND - .09, SEGMENTS, 3, true),
      new THREE.MeshPhongMaterial({
        map: terrainTex, side: THREE.BackSide,
        emissive: 0x07141d, emissiveIntensity: .58,
        specular: 0xb9e9ff, shininess: 22,
      })
    );
    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(R + HULL, R + HULL, BAND, SEGMENTS, 4, true),
      new THREE.MeshPhongMaterial({
        map: hullTex, color: 0xffffff,
        emissive: 0x061019, emissiveIntensity: .35,
        specular: 0xd7efff, shininess: 105,
      })
    );
    const wallMat = new THREE.MeshPhongMaterial({
      color: 0x35434d, emissive: 0x09141d, specular: 0xaedcff,
      shininess: 90, side: THREE.DoubleSide,
    });
    const wallTop = new THREE.Mesh(new THREE.RingGeometry(R - .03, R + HULL + .03, SEGMENTS, 2), wallMat);
    wallTop.rotation.x = -Math.PI / 2;
    wallTop.position.y = BAND / 2;
    const wallBot = wallTop.clone();
    wallBot.position.y = -BAND / 2;

    const railMat = new THREE.MeshPhongMaterial({
      color: 0x627583, emissive: 0x0a1c27, specular: 0xd5f2ff, shininess: 130,
    });
    const railTop = new THREE.Mesh(new THREE.TorusGeometry(R + .045, .058, 12, SEGMENTS), railMat);
    railTop.rotation.x = Math.PI / 2; railTop.position.y = BAND / 2;
    const railBot = railTop.clone(); railBot.position.y = -BAND / 2;

    const ribGeo = new THREE.BoxGeometry(.035, BAND * .7, .14);
    const ribMat = new THREE.MeshPhongMaterial({ color: 0x536573, emissive: 0x08141d, specular: 0xb8e3fb, shininess: 96 });
    const ribs = new THREE.InstancedMesh(ribGeo, ribMat, 72);
    const rib = new THREE.Object3D();
    for (let i = 0; i < 72; i++) {
      const a = i / 72 * Math.PI * 2;
      rib.position.set(Math.cos(a) * (R + HULL + .012), 0, Math.sin(a) * (R + HULL + .012));
      rib.rotation.y = -a;
      rib.updateMatrix();
      ribs.setMatrixAt(i, rib.matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;

    const atmo = new THREE.Mesh(
      new THREE.CylinderGeometry(R - .055, R - .055, BAND * .78, SEGMENTS, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x8fdcff, transparent: true, opacity: .052, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    const airRailMat = new THREE.MeshBasicMaterial({
      color: 0x8cddff, transparent: true, opacity: .19,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const airTop = new THREE.Mesh(new THREE.TorusGeometry(R - .06, .018, 8, SEGMENTS), airRailMat);
    airTop.rotation.x = Math.PI / 2; airTop.position.y = BAND * .39;
    const airBot = airTop.clone(); airBot.position.y = -BAND * .39;
    spinner.add(terrain, hull, wallTop, wallBot, railTop, railBot, ribs, atmo, airTop, airBot);

    const sun = new THREE.DirectionalLight(0xfff2d7, 1.7);
    sun.position.set(-8, 10, 7);
    const coolFill = new THREE.DirectionalLight(0x7dcfff, .48);
    coolFill.position.set(7, -3, -5);
    const fill = new THREE.AmbientLight(0x263947, .62);
    ring.add(sun, coolFill, fill);

    ring.rotation.set(.96, .08, -.27);
    ring.position.set(0, -.15, -1.55);
    ring.userData.spinner = spinner;
    return ring;
  }

  function layoutGraph(data) {
    const groupIndex = new Map(data.groups.map((g, i) => [g, i]));
    const groupCounts = new Map();
    const positions = new Array(data.nodes.length);
    data.nodes.forEach((node) => {
      const gi = groupIndex.get(node.group) ?? 0;
      const nth = groupCounts.get(node.group) || 0;
      groupCounts.set(node.group, nth + 1);
      const totalGroups = Math.max(1, data.groups.length);
      const gy = totalGroups === 1 ? 0 : 1 - (gi / (totalGroups - 1)) * 2;
      const radial = Math.sqrt(Math.max(0, 1 - gy * gy));
      const ga = gi * 2.399963229728653;
      const center = new THREE.Vector3(
        Math.cos(ga) * radial * 4.15,
        gy * 3.15,
        Math.sin(ga) * radial * 2.6
      );
      const seed = hash(node.path);
      const a = nth * 2.39996 + rand(seed) * .8;
      const localR = .22 + Math.sqrt(nth + 1) * .125 + rand(seed + 1) * .24;
      const localDepth = (rand(seed + 2) - .5) * 1.7;
      positions[node.id] = center.add(new THREE.Vector3(
        Math.cos(a) * localR,
        Math.sin(a) * localR * .72,
        localDepth
      ));
    });
    return positions;
  }

  function disposeGalaxy() {
    if (!galaxy) return;
    scene.remove(galaxy);
    galaxy.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    galaxy = points = linkLines = haloWorld = null;
  }

  function buildGalaxy(data) {
    disposeGalaxy();
    graphData = data;
    nodePositions = layoutGraph(data);
    galaxy = new THREE.Group();
    galaxy.visible = false;

    const groupMap = new Map(data.groups.map((g, i) => [g, COLORS[i % COLORS.length]]));
    const pos = [], colors = [];
    baseColors = [];
    for (const node of data.nodes) {
      const p = nodePositions[node.id];
      pos.push(p.x, p.y, p.z);
      const c = new THREE.Color(groupMap.get(node.group));
      baseColors[node.id] = c.clone();
      colors.push(c.r, c.g, c.b);
    }
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    nodeColors = new THREE.Float32BufferAttribute(colors, 3);
    pointGeo.setAttribute('color', nodeColors);
    points = new THREE.Points(pointGeo, new THREE.PointsMaterial({
      size: .12, map: spriteTexture(), vertexColors: true, transparent: true, opacity: .96,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));

    const linkPos = [];
    data.links.forEach((link) => {
      const a = nodePositions[link.source], b = nodePositions[link.target];
      if (a && b) linkPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    });
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.Float32BufferAttribute(linkPos, 3));
    linkLines = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: 0x4bdf9a, transparent: true, opacity: .13, blending: THREE.AdditiveBlending, depthWrite: false }));

    haloWorld = buildHaloWorld();
    galaxy.add(starfield(), haloWorld, linkLines, points);
    galaxy.rotation.x = -.08;
    scene.add(galaxy);
    raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = .13;

    const counts = data.groupCounts || data.nodes.reduce((acc, node) => {
      acc[node.group] = (acc[node.group] || 0) + 1;
      return acc;
    }, {});
    document.getElementById('galaxyMeta').textContent = `${data.noteCount} notes  ·  ${data.links.length} connections  ·  complete vault map  ·  private text stays local`;
    document.getElementById('galaxyLegend').innerHTML = data.groups.map((g, i) => `<span class="legendItem"><i style="--c:${cssHex(COLORS[i % COLORS.length])}"></i>${escapeHtml(g)} <b>${counts[g] || 0}</b></span>`).join('');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  function setView(name, persist = true) {
    const useGalaxy = name === 'galaxy' && galaxy;
    window.cortanaGalaxyActive = !!useGalaxy;
    document.body.classList.toggle('galaxy-view', !!useGalaxy);
    document.querySelectorAll('.viewBtn').forEach((b) => b.classList.toggle('active', b.dataset.view === (useGalaxy ? 'galaxy' : 'core')));
    if (galaxy) galaxy.visible = !!useGalaxy;
    // Core view uses the articulated Cortana SVG hologram. Keep the legacy
    // orb and its miniature graph hidden; the full Galaxy remains available.
    if (orbCore) orbCore.visible = false;
    if (orbAtmo) orbAtmo.visible = false;
    if (vaultGraph) vaultGraph.visible = false;
    document.getElementById('sourceCard').classList.remove('open');
    hovered = activeNode = null;
    if (useGalaxy) {
      targetCamera.set(0, .3, 10.5);
      targetLook.set(0, .1, 0);
      setState('idle');
    } else {
      targetCamera.set(0, 0, 3);
      targetLook.set(0, 0, 0);
    }
    if (persist) localStorage.setItem('cortana-view', useGalaxy ? 'galaxy' : 'core');
  }
  window.cortanaSetView = setView;

  function pickNode(e) {
    if (!window.cortanaGalaxyActive || !points || overUI(e)) return null;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(points)[0];
    return hit ? graphData.nodes[hit.index] : null;
  }

  function showSource(node, cited = false) {
    if (!node) return;
    activeNode = node;
    const card = document.getElementById('sourceCard');
    card.classList.toggle('redacted', !!node.redacted);
    card.querySelector('.sourceEyebrow').textContent = node.redacted
      ? `Private topology · ${node.group}`
      : (cited ? 'Answer source' : `Vault · ${node.group}`);
    card.querySelector('.sourceTitle').textContent = node.label;
    card.querySelector('.sourcePath').textContent = node.redacted ? 'LOCAL FGA-BRAIN VAULT ONLY' : node.path;
    card.querySelector('.sourceExcerpt').textContent = node.excerpt || 'No excerpt available.';
    card.querySelectorAll('.sourceActions button').forEach((button) => { button.disabled = !!node.redacted; });
    card.classList.add('open');
    if (cited) { card.classList.remove('sourcePulse'); void card.offsetWidth; card.classList.add('sourcePulse'); }
  }

  function highlight(ids) {
    if (!nodeColors) return;
    const set = new Set(ids);
    graphData.nodes.forEach((node) => {
      const c = set.has(node.id) ? STAR_COLOR : baseColors[node.id].clone().multiplyScalar(set.size ? .22 : 1);
      nodeColors.setXYZ(node.id, c.r, c.g, c.b);
    });
    nodeColors.needsUpdate = true;
    setTimeout(() => {
      if (!nodeColors) return;
      graphData.nodes.forEach((node) => nodeColors.setXYZ(node.id, baseColors[node.id].r, baseColors[node.id].g, baseColors[node.id].b));
      nodeColors.needsUpdate = true;
    }, 9000);
  }

  function flyToNode(node, cited = false) {
    if (!node || !nodePositions[node.id]) return;
    setView('galaxy');
    const world = nodePositions[node.id].clone().applyEuler(galaxy.rotation);
    targetLook.copy(world);
    const direction = world.clone().normalize();
    if (direction.lengthSq() < .01) direction.set(0, 0, 1);
    targetCamera.copy(world.clone().add(direction.multiplyScalar(2.5)).add(new THREE.Vector3(0, .25, 1.8)));
    highlight([node.id]);
    showSource(node, cited);
    lastInteraction = Date.now();
  }

  window.cortanaTraceSources = (sources) => {
    if (!sources || !sources.length || !graphData) return;
    const nodes = sources.map((src) => graphData.nodes.find((n) => n.path === src.path)).filter(Boolean);
    if (!nodes.length) return;
    setView('galaxy');
    highlight(nodes.map((n) => n.id));
    if (nodes.length < 4) flyToNode(nodes[0], true);
    else {
      targetCamera.set(0, .3, 10.5); targetLook.set(0, .1, 0);
      showSource(nodes[0], true);
    }
  };

  window.cortanaRemember = async (text) => {
    addMsg(text, 'thomas');
    input.value = ''; input.style.height = 'auto';
    sendBtn.disabled = true;
    setState('thinking');
    try {
      const res = await fetch('/api/remember', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || 'Capture failed');
      const data = JSON.parse(raw);
      await refreshGalaxy(data.path);
      const reply = window.CORTANA_STATIC_MODE
        ? `Saved in this browser-only field log, Chief. Connect the private core to make it permanent vault memory.`
        : `Filed in the vault, Chief. Another star joins the mission map; the paperwork remains mercifully terrestrial.`;
      addMsg(reply, 'cortana', { label: 'Local memory', effort: 'no model', reason: 'vault capture' });
      setState('speaking');
      speak(reply);
    } catch (err) {
      addMsg(`⚠ ${err.message}`, 'system');
      doneSpeaking();
    } finally { sendBtn.disabled = false; input.focus(); }
  };

  async function refreshGalaxy(flyPath) {
    const res = await fetch('/api/graph?refresh=1');
    if (!res.ok) throw new Error('Galaxy refresh failed');
    const data = await res.json();
    buildGalaxy(data);
    setView('galaxy');
    const node = data.nodes.find((n) => n.path === flyPath);
    if (node) setTimeout(() => flyToNode(node, true), 180);
  }
  window.cortanaRefreshGalaxy = () => refreshGalaxy();

  function bindControls() {
    window.addEventListener('mousemove', (e) => {
      if (!window.cortanaGalaxyActive) return;
      if (dragging) {
        galaxy.rotation.y = rotationStart.y + (e.clientX - dragStart.x) * .004;
        galaxy.rotation.x = Math.max(-.7, Math.min(.7, rotationStart.x + (e.clientY - dragStart.y) * .003));
        lastInteraction = Date.now();
        return;
      }
      hovered = pickNode(e);
      if (hovered) {
        nodeTip.innerHTML = `<span class="ntype">◈ ${escapeHtml(hovered.group)}</span>${escapeHtml(hovered.label)}`;
        nodeTip.className = 'file'; nodeTip.style.display = 'block';
        nodeTip.style.left = Math.min(e.clientX + 14, window.innerWidth - 260) + 'px';
        nodeTip.style.top = (e.clientY - 28) + 'px'; document.body.style.cursor = 'pointer';
      } else if (!overUI(e)) { nodeTip.style.display = 'none'; document.body.style.cursor = ''; }
    });
    window.addEventListener('mousedown', (e) => {
      if (!window.cortanaGalaxyActive || overUI(e)) return;
      dragging = true; dragStart = { x: e.clientX, y: e.clientY }; rotationStart = { x: galaxy.rotation.x, y: galaxy.rotation.y };
    });
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      dragging = false;
      if (moved < 5) { const node = pickNode(e); if (node) flyToNode(node); }
    });
    window.addEventListener('wheel', (e) => {
      if (!window.cortanaGalaxyActive || overUI(e)) return;
      targetCamera.z = Math.max(3.2, Math.min(17, targetCamera.z + e.deltaY * .008));
      lastInteraction = Date.now();
    }, { passive: true });
    window.addEventListener('dblclick', (e) => {
      if (!window.cortanaGalaxyActive || overUI(e)) return;
      targetCamera.set(0, .3, 10.5); targetLook.set(0, .1, 0);
      lastInteraction = Date.now();
      document.getElementById('sourceCard').classList.remove('open');
    });
  }

  window.cortanaGalaxyTick = () => {
    if (!galaxy || !window.cortanaGalaxyActive) return;
    if (haloWorld && haloWorld.userData.spinner) haloWorld.userData.spinner.rotation.y += .0006;
    const idleFor = Date.now() - lastInteraction;
    if (!dragging && idleFor > 3500) galaxy.rotation.y += .00034;
    if (!dragging && idleFor > 9500) {
      const t = Date.now() * .0001;
      targetCamera.set(Math.sin(t) * .72, .25 + Math.sin(t * 1.7) * .24, 10.2 + Math.cos(t * .82) * .7);
      targetLook.set(Math.sin(t * .7) * .2, Math.cos(t * .9) * .12, 0);
    }
    camera.position.lerp(targetCamera, .045);
    lookTarget.lerp(targetLook, .055);
    camera.lookAt(lookTarget);
  };

  async function init() {
    buildChrome();
    bindControls();
    window.cortanaGalaxyActive = true;
    document.body.classList.add('galaxy-view');
    if (orbCore) orbCore.visible = false;
    if (orbAtmo) orbAtmo.visible = false;
    if (vaultGraph) vaultGraph.visible = false;
    try {
      const res = await fetch('/api/graph');
      if (!res.ok) throw new Error('Graph unavailable');
      const data = await res.json();
      buildGalaxy(data);
      // Core is the hologram front door on Pages; Galaxy stays one tap away.
      const saved = localStorage.getItem('cortana-view');
      setView(saved === 'galaxy' ? 'galaxy' : 'core', false);
      window.cortanaGalaxyReady = true;
      if (!booted) {
        booted = true;
        addMsg(`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, Chief. ${data.noteCount} notes indexed. Cortana is online and ready for the mission.`, 'cortana');
      }
    } catch (err) {
      setView('core', false);
      window.cortanaGalaxyReady = true;
      document.getElementById('galaxyMeta').textContent = 'Galaxy offline · core systems remain available';
      addMsg('Core systems online, Chief. The galaxy is being temperamental; how very celestial of it.', 'cortana');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
