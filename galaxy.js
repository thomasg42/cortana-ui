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

  /* One camera model for the whole Galaxy: a look point, a direction and a
     distance. Zoom only ever changes the distance, so scrolling out undoes a
     scroll in exactly — and every zoom-out ends with the Halo centered again,
     because past the home distance the drilled-in anchor is released and the
     ring is the frame once more. */
  const HOME_LOOK = new THREE.Vector3(0, .1, 0);
  const HOME_OFFSET = new THREE.Vector3(0, .2, 10.5);
  const HOME_DIR = HOME_OFFSET.clone().normalize();
  const HOME_DIST = HOME_OFFSET.length();
  const MIN_DIST = 1.7;
  const MAX_DIST = 17;
  let focusAnchor = null;
  let zoomDist = HOME_DIST;
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let rotationStart = { x: 0, y: 0 };
  let lastInteraction = Date.now();
  let booted = false;
  let galaxyBackdrop = null;

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
  const clampDist = (d) => Math.max(MIN_DIST, Math.min(MAX_DIST, d));

  function applyFraming() {
    if (!focusAnchor) {
      targetLook.copy(HOME_LOOK);
      targetCamera.copy(HOME_LOOK).addScaledVector(HOME_DIR, zoomDist);
      return;
    }
    const span = HOME_DIST - focusAnchor.dist;
    const t = span > .05 ? Math.max(0, Math.min(1, (zoomDist - focusAnchor.dist) / span)) : 1;
    const look = focusAnchor.look.clone().lerp(HOME_LOOK, t);
    const dir = focusAnchor.dir.clone().lerp(HOME_DIR, t).normalize();
    targetLook.copy(look);
    targetCamera.copy(look).addScaledVector(dir, zoomDist);
    // Fully zoomed back out — hand the frame back to the Halo.
    if (t >= 1) focusAnchor = null;
  }

  function focusOn(worldPoint, offset) {
    const framing = offset.lengthSq() > 1e-6 ? offset.clone() : HOME_OFFSET.clone();
    focusAnchor = {
      look: worldPoint.clone(),
      dir: framing.clone().normalize(),
      dist: Math.min(clampDist(framing.length()), HOME_DIST - .6),
    };
    zoomDist = focusAnchor.dist;
    applyFraming();
    lastInteraction = Date.now();
  }

  function goHome() {
    focusAnchor = null;
    zoomDist = HOME_DIST;
    applyFraming();
    lastInteraction = Date.now();
  }

  function buildChrome() {
    galaxyBackdrop = document.createElement('div');
    galaxyBackdrop.id = 'galaxyBackdrop';
    galaxyBackdrop.setAttribute('aria-hidden', 'true');
    document.body.prepend(galaxyBackdrop);

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

    const drilldown = document.createElement('aside');
    drilldown.id = 'topicDrilldown';
    document.body.appendChild(drilldown);
    drilldown.addEventListener('click', handleDrilldownClick);

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) setView(btn.dataset.view);
    });
    source.querySelector('[data-action="open"]').addEventListener('click', () => activeNode && !activeNode.redacted && openFile(activeNode.path));
    source.querySelector('[data-action="context"]').addEventListener('click', () => {
      if (activeNode && !activeNode.redacted && !contextFiles.includes(activeNode.path)) { contextFiles.push(activeNode.path); renderChips(); }
      source.classList.remove('open');
    });
    document.getElementById('galaxyLegend').addEventListener('click', (e) => {
      const item = e.target.closest('[data-group]');
      if (item) zoomToTopic(item.dataset.group);
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
    document.getElementById('galaxyLegend').innerHTML = data.groups.map((g, i) => `<button class="legendItem" data-group="${escapeHtml(g)}"><i style="--c:${cssHex(COLORS[i % COLORS.length])}"></i>${escapeHtml(g)} <b>${counts[g] || 0}</b></button>`).join('');
    closeDrilldown();
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
    if (!useGalaxy) closeDrilldown();
    if (useGalaxy) {
      goHome();
      setState('idle');
    } else {
      focusAnchor = null;
      zoomDist = HOME_DIST;
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
    const direction = world.clone().normalize();
    if (direction.lengthSq() < .01) direction.set(0, 0, 1);
    focusOn(world, direction.multiplyScalar(2.5).add(new THREE.Vector3(0, .25, 1.8)));
    highlight([node.id]);
    showSource(node, cited);
  }

  // Topic drill-down / outline — zoom into a legend group ("topic") or a
  // spoken request ("give me all the YouTube videos"), then regroup those
  // notes by Topic / Year / YouTube / Business / Class. All dimensions are
  // best-effort fields computed server-side in buildKnowledgeGraph; every
  // view shows all its tabs, defaulting to whichever one carries the single
  // biggest sub-cluster for THIS set (most nodes under one label wins the
  // opening view — Thomas can still switch tabs manually).
  const DIM_LABELS = { topic: 'Topic', year: 'Year', youtube: 'YouTube', business: 'Business', class: 'Class' };
  const TOPIC_DIMS = ['year', 'youtube', 'business', 'class'];
  const OUTLINE_DIMS = ['topic', 'year', 'youtube', 'business', 'class'];
  const OUTLINE_NOTE_BUDGET = 300;
  let drilldownState = null; // { mode, title, group, nodeIds, tab, subValue }

  function subClusterKey(node, dimension) {
    if (dimension === 'topic') return node.group || 'Unclassified';
    if (dimension === 'year') return node.year || 'Unclassified';
    if (dimension === 'youtube') return node.youtube ? node.youtube.channel : 'No video source';
    if (dimension === 'business') return node.business || 'Unclassified';
    return node.class || 'Unclassified';
  }

  /* The "little ideation" under each note — one readable line of what this
     thing actually is. Vault pages come in two shapes: plain markdown, and
     knowledge-base pages that open with their own title and a FOLDER /
     DESTINATION-ID header block. For the second shape the source video's own
     title is the useful line; otherwise take the first real prose sentence.
     Only real field names end the header run — a bare acronym like "SEO:"
     inside a title must not be mistaken for one. */
  const KB_FIELD = /(?:^|\s)(?:VIDEO|DOCUMENT|DESTINATION|KNOWLEDGE|FOLDER|CHANNEL|CREATOR|SOURCE|CATEGORY|HANDLE|STATUS|TAGS|DATE|URL|LINK|CAPTURED|CREATED|UPDATED|OWNER)\b[A-Z0-9 ]*:/;
  const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  function stripLeadingLabel(text, label) {
    const target = normKey(label);
    if (target.length < 8) return text;
    let seen = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i].toLowerCase();
      if (/[a-z0-9]/.test(ch)) {
        seen += ch;
        if (!target.startsWith(seen)) return text;
        if (seen.length === target.length) return text.slice(i + 1);
      }
    }
    return text;
  }

  /* A field value ends at the next header field. If there is no next field the
     excerpt itself may have been cut short, so say so rather than ending on
     half a word. */
  function untilField(value) {
    const stop = value.search(KB_FIELD);
    if (stop > 0) return value.slice(0, stop).trim();
    const cut = value.trim();
    return /[.!?)"']$/.test(cut) ? cut : cut + '…';
  }

  function nodeIdeation(node) {
    if (!node) return '';
    if (node.redacted) return 'Private topology · open the local core to read this note.';
    if (node.idea) return trimIdea(node.idea);
    const raw = String(node.excerpt || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const label = String(node.label || '').trim();

    // A field only earns the line if it says something the title doesn't.
    const usable = (value) => value.length > 8
      && !/^https?:/i.test(value)
      && !normKey(value).startsWith(normKey(label).slice(0, 24));

    const titled = raw.match(/\b(?:VIDEO|DOCUMENT)\s+TITLE:\s*(\S.*)$/);
    if (titled) {
      const value = untilField(titled[1]);
      if (usable(value)) return trimIdea(value);
    }
    const sourced = raw.match(/\bSource video:\s*(\S.*)$/i);
    if (sourced) {
      const value = untilField(sourced[1]).replace(/\s*\(YouTube\)\s*…?$/i, '').trim();
      if (usable(value)) return trimIdea(value);
    }

    const lead = /^[\s*·|,:;>)\]"'-]+/;
    let text = stripLeadingLabel(raw, label).replace(/=+/g, ' ').replace(/-{3,}/g, ' ');
    // Skip past a knowledge-base header block to the prose underneath it.
    const header = text.match(/DESTINATION FOLDER ID:\s*\S+/i);
    if (header) text = text.slice(text.indexOf(header[0]) + header[0].length);
    text = stripLeadingLabel(text.replace(lead, '').trim(), label);
    text = text
      .replace(/\*+/g, '')
      .replace(/^\s*FOREVER GOLD AI\s*[—-]?\s*(?:KNOWLEDGE BASE|BUILD)?\s*DOCUMENT\s*/i, '')
      .replace(lead, '')
      // Drop the provenance stamp notes open with; the gist is what follows.
      .replace(/^(?:Source|Captured|Date ingested|Ingested|Added)\s*:?\s*/i, '')
      .replace(/^(?:manual|sync-projects|drive-sync-check|import|Drive|Telegram)\s*[—·-]+\s*\d{4}-\d{2}-\d{2}\.?\s*/i, '')
      .replace(lead, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length < 14 || /^https?:/i.test(text) ? '' : trimIdea(text);
  }

  function trimIdea(text, max = 132) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '), cut.lastIndexOf(' '));
    return (stop > max * .5 ? cut.slice(0, stop) : cut).replace(/[\s,;:—-]+$/, '') + '…';
  }

  function computeSubClusters(nodeIds, dimension) {
    const byLabel = new Map();
    for (const id of nodeIds) {
      const node = graphData.nodes[id];
      const key = subClusterKey(node, dimension);
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key).push(id);
    }
    return [...byLabel.entries()]
      .map(([label, ids]) => ({ label, ids }))
      .sort((a, b) => b.ids.length - a.ids.length);
  }

  const DRILL_EMPTY_LABELS = new Set(['Unclassified', 'No video source']);
  function bestDimension(nodeIds, dims = TOPIC_DIMS) {
    // Prefer whichever dimension has the biggest REAL sub-cluster — an
    // "Unclassified" catch-all winning by size isn't a useful default tab.
    let best = dims[dims.length - 1], bestCount = -1;
    for (const dim of dims) {
      const clusters = computeSubClusters(nodeIds, dim);
      const top = clusters.find((c) => !DRILL_EMPTY_LABELS.has(c.label)) || clusters[0];
      if (top && top.ids.length > bestCount) { bestCount = top.ids.length; best = dim; }
    }
    return best;
  }

  function flyToCentroid(nodeIds) {
    if (!nodeIds.length) return;
    const center = new THREE.Vector3();
    nodeIds.forEach((id) => { if (nodePositions[id]) center.add(nodePositions[id]); });
    center.divideScalar(nodeIds.length);
    const world = center.clone().applyEuler(galaxy.rotation);
    const direction = world.clone().normalize();
    if (direction.lengthSq() < .01) direction.set(0, 0, 1);
    const spread = nodeIds.length > 1 ? 2.15 + Math.sqrt(nodeIds.length) * .16 : 2.5;
    focusOn(world, direction.multiplyScalar(spread).add(new THREE.Vector3(0, .25, 1.6)));
  }

  function zoomToTopic(group) {
    if (!graphData) return;
    const nodeIds = graphData.nodes.filter((n) => n.group === group).map((n) => n.id);
    if (!nodeIds.length) return;
    setView('galaxy');
    highlight(nodeIds);
    flyToCentroid(nodeIds);
    openDrilldown(group, nodeIds);
  }

  function openDrilldown(group, nodeIds) {
    drilldownState = { mode: 'topic', title: group, group, nodeIds, tab: bestDimension(nodeIds, TOPIC_DIMS), subValue: null };
    document.querySelectorAll('.legendItem').forEach((el) => el.classList.toggle('active', el.dataset.group === group));
    document.getElementById('topicDrilldown').classList.add('open');
    renderDrilldown();
  }

  function openOutline({ title, nodeIds, dimension }) {
    const dims = OUTLINE_DIMS;
    drilldownState = {
      mode: 'outline',
      title,
      group: null,
      nodeIds,
      tab: dims.includes(dimension) ? dimension : bestDimension(nodeIds, dims),
      subValue: null,
    };
    document.querySelectorAll('.legendItem').forEach((el) => el.classList.remove('active'));
    document.getElementById('topicDrilldown').classList.add('open');
    renderDrilldown();
  }

  function closeDrilldown() {
    drilldownState = null;
    document.querySelectorAll('.legendItem').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById('topicDrilldown');
    if (panel) panel.classList.remove('open');
  }

  function noteRow(id) {
    const node = graphData.nodes[id];
    const idea = nodeIdeation(node);
    return `<button class="drillNote" data-node="${id}"><span class="dnTitle">${escapeHtml(node.label)}</span>${idea ? `<span class="dnIdea">${escapeHtml(idea)}</span>` : ''}</button>`;
  }

  /* The outline: every note in the set, grouped under its sub-cluster with a
     one-line gist, so "give me all the YouTube videos" reads as a scannable
     list instead of an anonymous cloud of stars. Picking one cluster focuses
     it; picking it again reopens the whole outline. */
  function renderDrilldown() {
    if (!drilldownState) return;
    const panel = document.getElementById('topicDrilldown');
    const { mode, title, nodeIds, tab, subValue } = drilldownState;
    const dims = mode === 'outline' ? OUTLINE_DIMS : TOPIC_DIMS;
    const clusters = computeSubClusters(nodeIds, tab);
    let budget = OUTLINE_NOTE_BUDGET;
    const sections = clusters.map((c) => {
      const open = subValue ? c.label === subValue : true;
      let body = '';
      if (open) {
        const shown = c.ids.slice(0, Math.max(0, budget));
        budget -= shown.length;
        const rest = c.ids.length - shown.length;
        body = `<div class="drillNotes">${shown.map(noteRow).join('')}${rest > 0 ? `<div class="drillMore">+${rest} more — pick this group to focus it</div>` : ''}</div>`;
      }
      return `<div class="drillSection${open ? ' open' : ''}">
        <button class="drillCluster${c.label === subValue ? ' active' : ''}" data-sub="${escapeHtml(c.label)}">${escapeHtml(c.label)} <b>${c.ids.length}</b></button>
        ${body}
      </div>`;
    }).join('');
    panel.innerHTML = `
      <div class="drillHead">
        <button class="drillBack" data-action="drillClose">◄ Full galaxy</button>
        <div class="drillTitle">${escapeHtml(title)} <b>${nodeIds.length}</b></div>
      </div>
      <div class="drillTabs">${dims.map((key) => `<button class="drillTab ${key === tab ? 'active' : ''}" data-tab="${key}">${DIM_LABELS[key]}</button>`).join('')}</div>
      <div class="drillOutline">${sections}</div>
    `;
    panel.querySelector('.drillOutline').scrollTop = 0;
  }

  function handleDrilldownClick(e) {
    if (!drilldownState) return;
    if (e.target.closest('[data-action="drillClose"]')) {
      closeDrilldown();
      goHome();
      return;
    }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { drilldownState.tab = tabBtn.dataset.tab; drilldownState.subValue = null; renderDrilldown(); return; }
    const subBtn = e.target.closest('[data-sub]');
    if (subBtn) {
      const label = subBtn.dataset.sub;
      const wasActive = drilldownState.subValue === label;
      drilldownState.subValue = wasActive ? null : label;
      renderDrilldown();
      if (!wasActive) {
        const cluster = computeSubClusters(drilldownState.nodeIds, drilldownState.tab).find((c) => c.label === label);
        if (cluster) { flyToCentroid(cluster.ids); highlight(cluster.ids); }
      } else {
        flyToCentroid(drilldownState.nodeIds);
        highlight(drilldownState.nodeIds);
      }
      return;
    }
    const noteBtn = e.target.closest('[data-node]');
    if (noteBtn) {
      const node = graphData.nodes[Number(noteBtn.dataset.node)];
      if (node) flyToNode(node);
    }
  }

  /* Asking for a kind of thing in conversation ("give me all the YouTube
     videos", "show me every Kraken note") outlines that whole set in the
     Galaxy instead of leaving Thomas to hunt for stars by hand. Matching is
     local and deterministic — it never calls a model — and it only fires on
     a collection-shaped ask so ordinary chat is left alone. */
  const OUTLINE_CUE = /\b(all|every|list|show|give|find|group|outline|where|map|pull\s*up)\b/i;
  const OUTLINE_SET_CUE = /\b(all|every|list|group|outline)\b/i;
  const OUTLINE_STOPWORDS = new Set([
    'all', 'every', 'list', 'show', 'give', 'find', 'group', 'outline', 'where', 'map', 'pull',
    'the', 'them', 'these', 'those', 'that', 'this', 'and', 'for', 'with', 'from', 'about',
    'into', 'have', 'has', 'are', 'was', 'were', 'you', 'your', 'me', 'my', 'our', 'please',
    'cortana', 'chief', 'notes', 'note', 'stuff', 'things', 'thing', 'everything', 'anything',
    'what', 'which', 'got', 'get', 'want', 'need', 'lets', 'let', 'can', 'could', 'would',
  ]);

  function resolveOutline(text) {
    if (!graphData || !graphData.nodes.length) return null;
    const q = String(text || '').toLowerCase();
    if (!OUTLINE_CUE.test(q)) return null;
    const pick = (filter) => graphData.nodes.filter(filter).map((n) => n.id);

    if (/\b(youtube|video|videos|vids|vid)\b/.test(q)) {
      const ids = pick((n) => !!n.youtube);
      if (ids.length > 1) return { title: 'YouTube videos', nodeIds: ids, dimension: 'topic' };
    }
    for (const group of graphData.groups) {
      const name = String(group).toLowerCase();
      if (name.length > 2 && (q.includes(name) || q.includes(name.replace(/s$/, '')))) {
        const ids = pick((n) => n.group === group);
        if (ids.length > 1) return { title: group, nodeIds: ids, dimension: bestDimension(ids, OUTLINE_DIMS) };
      }
    }
    for (const dim of ['business', 'class']) {
      const values = [...new Set(graphData.nodes.map((n) => n[dim]).filter(Boolean))];
      for (const value of values) {
        const name = String(value).toLowerCase();
        if (name.length > 3 && q.includes(name)) {
          const ids = pick((n) => n[dim] === value);
          if (ids.length > 1) return { title: value, nodeIds: ids, dimension: dim === 'business' ? 'class' : 'topic' };
        }
      }
    }
    const year = q.match(/\b(20\d{2})\b/);
    if (year) {
      const ids = pick((n) => n.year === year[1]);
      if (ids.length > 1) return { title: year[1], nodeIds: ids, dimension: 'topic' };
    }
    if (!OUTLINE_SET_CUE.test(q)) return null;
    const terms = q.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !OUTLINE_STOPWORDS.has(w));
    if (!terms.length) return null;
    const ids = pick((n) => {
      const hay = `${n.label} ${n.path} ${n.excerpt || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    if (ids.length > 2) return { title: `“${terms.join(' ')}”`, nodeIds: ids, dimension: 'topic' };
    return null;
  }

  window.cortanaOutlineQuery = (text) => {
    const match = resolveOutline(text);
    if (!match) return false;
    setView('galaxy');
    highlight(match.nodeIds);
    flyToCentroid(match.nodeIds);
    openOutline(match);
    return true;
  };

  window.cortanaTraceSources = (sources) => {
    if (!sources || !sources.length || !graphData) return;
    const nodes = sources.map((src) => graphData.nodes.find((n) => n.path === src.path)).filter(Boolean);
    if (!nodes.length) return;
    setView('galaxy');
    highlight(nodes.map((n) => n.id));
    // An outline Thomas just asked for outranks the answer's own citations —
    // don't yank the panel or the camera out from under it.
    if (drilldownState && drilldownState.mode === 'outline') { showSource(nodes[0], true); return; }
    const groups = new Set(nodes.map((n) => n.group));
    if (groups.size === 1) openDrilldown([...groups][0], nodes.map((n) => n.id));
    else closeDrilldown();
    if (nodes.length < 4) flyToNode(nodes[0], true);
    else {
      goHome();
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
      // Multiplicative: N clicks out exactly undo N clicks in, and the last
      // click out always lands back on the Halo-centred home frame.
      zoomDist = clampDist(zoomDist * Math.exp(e.deltaY * .0014));
      applyFraming();
      lastInteraction = Date.now();
    }, { passive: true });
    window.addEventListener('dblclick', (e) => {
      if (!window.cortanaGalaxyActive || overUI(e)) return;
      goHome();
      document.getElementById('sourceCard').classList.remove('open');
      closeDrilldown();
    });
  }

  window.cortanaGalaxyTick = () => {
    if (!galaxy || !window.cortanaGalaxyActive) return;
    if (haloWorld && haloWorld.userData.spinner) haloWorld.userData.spinner.rotation.y += .0006;
    const idleFor = Date.now() - lastInteraction;
    if (!dragging && idleFor > 3500) galaxy.rotation.y += .00034;
    // Idle breathing only belongs to the home frame — once Thomas has zoomed
    // into something, the camera stays where he parked it.
    if (!dragging && idleFor > 9500 && !focusAnchor) {
      const t = Date.now() * .0001;
      targetCamera.set(Math.sin(t) * .72, .25 + Math.sin(t * 1.7) * .24, zoomDist - .3 + Math.cos(t * .82) * .7);
      targetLook.set(Math.sin(t * .7) * .2, Math.cos(t * .9) * .12, 0);
    }
    camera.position.lerp(targetCamera, .045);
    lookTarget.lerp(targetLook, .055);
    camera.lookAt(lookTarget);
    if (galaxyBackdrop) {
      const distance = camera.position.distanceTo(lookTarget);
      const depth = Math.max(0, Math.min(1, (distance - 3.2) / 13.8));
      const bgScale = 1.15 - depth * .12;
      const bgX = -Math.sin(galaxy.rotation.y) * .65;
      const bgY = galaxy.rotation.x * .7;
      galaxyBackdrop.style.setProperty('--galaxy-bg-scale', bgScale.toFixed(4));
      galaxyBackdrop.style.setProperty('--galaxy-bg-x', `${bgX.toFixed(3)}%`);
      galaxyBackdrop.style.setProperty('--galaxy-bg-y', `${bgY.toFixed(3)}%`);
      galaxyBackdrop.style.setProperty('--galaxy-bg-brightness', (.72 + depth * .18).toFixed(3));
      galaxyBackdrop.style.setProperty('--galaxy-bg-blur', `${(1.25 - depth * .95).toFixed(2)}px`);
      galaxyBackdrop.style.setProperty('--galaxy-bg-opacity', (.84 + depth * .12).toFixed(3));
    }
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
