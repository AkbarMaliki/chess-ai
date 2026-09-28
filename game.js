'use strict';
/* Chess 3D — render Three.js, mode lokal / bot / online (Firebase Realtime Database) */

const { Chess, bestMove, uci, colorOf } = window.ChessEngine;
const $ = id => document.getElementById(id);
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const LEVEL_HINT = {
  easy: 'Bot santai — sering salah langkah. Cocok untuk belajar.',
  medium: 'Bot melihat 2 langkah ke depan dan jarang blunder.',
  hard: 'Bot berpikir lebih dalam (±2 detik per langkah). Hati-hati!',
};
const REASON = {
  checkmate: 'Skak mat', stalemate: 'Stalemate — raja tidak bisa bergerak', fifty: 'Aturan 50 langkah',
  material: 'Bidak tidak cukup untuk mat', repetition: 'Posisi berulang 3 kali', resign: 'Menyerah',
  timeout: 'Waktu habis', agreement: 'Remis disepakati', abandon: 'Lawan meninggalkan permainan',
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } },
};
const other = c => (c === 'w' ? 'b' : 'w');
const fmtClock = ms => {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  if (ms < 10000) return (ms / 1000).toFixed(1);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// =====================================================================
// Suara (WebAudio, tanpa file)
// =====================================================================
const Sound = (() => {
  let ctx = null, on = LS.get('chess_sound', '1') === '1';
  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type = 'sine', vol = 0.2, delay = 0, slide = 0) {
    if (!on) return;
    const c = ac();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }
  return {
    get on() { return on; },
    toggle() { on = !on; LS.set('chess_sound', on ? '1' : '0'); return on; },
    unlock: ac,
    select() { tone(700, 0.05, 'sine', 0.08); },
    move() { tone(240, 0.09, 'triangle', 0.3, 0, 120); },
    capture() { tone(170, 0.14, 'square', 0.12, 0, 60); tone(480, 0.08, 'triangle', 0.18, 0.03); },
    check() { tone(660, 0.12, 'sawtooth', 0.1); tone(880, 0.2, 'sawtooth', 0.09, 0.1); },
    start() { [523, 659, 784].forEach((f, i) => tone(f, 0.2, 'triangle', 0.16, i * 0.09)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.28, 'triangle', 0.16, i * 0.11)); },
    lose() { [440, 370, 311, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.15, i * 0.14)); },
    notify() { tone(990, 0.1, 'sine', 0.13); tone(1320, 0.12, 'sine', 0.1, 0.08); },
  };
})();

// =====================================================================
// Scene 3D
// =====================================================================
const container = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0620, 22, 60);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 150);
camera.position.set(0, 10, 9);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 30;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = Math.PI * 0.46;
controls.autoRotateSpeed = 0.6;

scene.add(new THREE.HemisphereLight(0xc9bfff, 0x1a1033, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.95);
sun.position.set(5, 13, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const cyanLight = new THREE.PointLight(0x28e8ff, 0.7, 30);
cyanLight.position.set(-7, 5, -6);
scene.add(cyanLight);
const pinkLight = new THREE.PointLight(0xff4fa3, 0.55, 30);
pinkLight.position.set(7, 5, 6);
scene.add(pinkLight);

// ---- papan ----
const sqPos = s => new THREE.Vector3((s & 7) - 3.5, 0, 3.5 - (s >> 3));
const squares = [];
{
  const geo = new THREE.BoxGeometry(1, 0.2, 1);
  const light = new THREE.MeshStandardMaterial({ color: 0xd8d0f7, roughness: 0.55, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a3a8f, roughness: 0.45, metalness: 0.12 });
  for (let s = 0; s < 64; s++) {
    const m = new THREE.Mesh(geo, (((s & 7) + (s >> 3)) & 1) ? light : dark);
    m.position.copy(sqPos(s)).setY(-0.1);
    m.receiveShadow = true;
    m.userData.sq = s;
    scene.add(m);
    squares.push(m);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.3, 0.36, 9.3),
    new THREE.MeshStandardMaterial({ color: 0x160e33, roughness: 0.4, metalness: 0.4 }));
  frame.position.y = -0.2;
  frame.receiveShadow = true;
  scene.add(frame);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(frame.geometry),
    new THREE.LineBasicMaterial({ color: 0x28e8ff, transparent: true, opacity: 0.55 }));
  edges.position.copy(frame.position);
  scene.add(edges);
  const inner = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(8.04, 8.04)),
    new THREE.LineBasicMaterial({ color: 0x7c5cff }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.002;
  scene.add(inner);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64),
    new THREE.MeshStandardMaterial({ color: 0x0d0826, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.42;
  floor.receiveShadow = true;
  scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(7.2, 7.32, 96),
    new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.35 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.41;
  scene.add(ring);
}

// ---- label koordinat ----
const labels = [];
function labelMesh(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#b7a9ff';
  g.font = 'bold 40px Orbitron, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  scene.add(m);
  labels.push(m);
  return m;
}
for (let i = 0; i < 8; i++) {
  for (const z of [4.33, -4.33]) labelMesh('abcdefgh'[i]).position.set(i - 3.5, -0.01, z);
  for (const x of [-4.33, 4.33]) labelMesh(String(i + 1)).position.set(x, -0.01, 3.5 - i);
}
function orientLabels(color) { for (const l of labels) l.rotation.z = color === 'b' ? Math.PI : 0; }

// ---- bidak ----
const V2 = pts => pts.map(([x, y]) => new THREE.Vector2(x, y));
const BASE = [[0, 0], [0.36, 0], [0.37, 0.03], [0.36, 0.07], [0.31, 0.1], [0.3, 0.13], [0.26, 0.15]];
const lathe = pts => new THREE.LatheGeometry(V2(BASE.concat(pts)), 40);
const sphere = r => new THREE.SphereGeometry(r, 18, 12);
const PARTS = (() => {
  const P = {};
  P.p = [{ geo: lathe([[0.2, 0.17], [0.13, 0.24], [0.1, 0.36], [0.15, 0.38], [0.16, 0.41], [0.1, 0.43], [0.11, 0.45]]) },
    { geo: sphere(0.15), y: 0.56 }];
  const rook = [{ geo: lathe([[0.25, 0.18], [0.21, 0.24], [0.19, 0.52], [0.25, 0.56], [0.27, 0.6], [0.27, 0.68], [0.18, 0.68], [0.18, 0.64], [0, 0.64]]) }];
  const merlon = new THREE.BoxGeometry(0.1, 0.12, 0.09);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rook.push({ geo: merlon, x: Math.cos(a) * 0.225, z: Math.sin(a) * 0.225, y: 0.73, ry: -a });
  }
  P.r = rook;
  P.b = [{ geo: lathe([[0.22, 0.18], [0.14, 0.26], [0.11, 0.5], [0.18, 0.53], [0.19, 0.56], [0.12, 0.58], [0.15, 0.62], [0.19, 0.7], [0.19, 0.78], [0.15, 0.86], [0.08, 0.92], [0, 0.94]]) },
    { geo: sphere(0.055), y: 0.98 }];
  const queen = [{ geo: lathe([[0.23, 0.18], [0.15, 0.27], [0.11, 0.62], [0.19, 0.65], [0.2, 0.69], [0.13, 0.72], [0.14, 0.76], [0.22, 0.95], [0.2, 0.97], [0.13, 0.97], [0.1, 1.02], [0.06, 1.05], [0, 1.06]]) },
    { geo: sphere(0.065), y: 1.1 }];
  const ball = sphere(0.035);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    queen.push({ geo: ball, x: Math.cos(a) * 0.205, z: Math.sin(a) * 0.205, y: 0.985 });
  }
  P.q = queen;
  P.k = [{ geo: lathe([[0.24, 0.18], [0.16, 0.27], [0.12, 0.68], [0.2, 0.71], [0.21, 0.75], [0.14, 0.78], [0.15, 0.82], [0.21, 1.0], [0.2, 1.03], [0.08, 1.06], [0, 1.07]]) },
    { geo: new THREE.BoxGeometry(0.07, 0.26, 0.07), y: 1.2 },
    { geo: new THREE.BoxGeometry(0.2, 0.07, 0.07), y: 1.22 }];
  const shape = new THREE.Shape();
  const hp = [[-0.2, 0.2], [0.2, 0.2], [0.16, 0.36], [0.3, 0.56], [0.37, 0.64], [0.35, 0.72], [0.26, 0.77], [0.1, 0.88], [0.07, 0.99], [0.02, 0.93], [-0.04, 0.99], [-0.08, 0.88], [-0.2, 0.8], [-0.26, 0.6], [-0.24, 0.4]];
  shape.moveTo(hp[0][0], hp[0][1]);
  for (const [x, y] of hp.slice(1)) shape.lineTo(x, y);
  const head = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.04, bevelSegments: 4, curveSegments: 4 });
  head.translate(0, 0, -0.08);
  head.computeVertexNormals();
  const mane = new THREE.BoxGeometry(0.08, 0.5, 0.1);
  mane.rotateZ(-0.35);
  mane.translate(-0.17, 0.62, 0);
  const eye = new THREE.SphereGeometry(0.035, 10, 8);
  P.n = [{ geo: lathe([[0.25, 0.18], [0.23, 0.24], [0, 0.24]]) }, { geo: head, head: true }, { geo: mane, head: true },
    { geo: eye.clone().translate(0.15, 0.74, 0.14), head: true, dark: true }, { geo: eye.clone().translate(0.15, 0.74, -0.14), head: true, dark: true }];
  return P;
})();
const MATS = {
  w: new THREE.MeshStandardMaterial({ color: 0xf4ecdc, roughness: 0.3, metalness: 0.06, emissive: 0x16122a }),
  b: new THREE.MeshStandardMaterial({ color: 0x2b2336, roughness: 0.25, metalness: 0.45, emissive: 0x0a0614 }),
};
const EYE_MAT = {
  w: new THREE.MeshStandardMaterial({ color: 0x1b1030, roughness: 0.2 }),
  b: new THREE.MeshStandardMaterial({ color: 0x28e8ff, emissive: 0x28e8ff, emissiveIntensity: 0.6 }),
};
const SEL_MATS = {
  w: MATS.w.clone(),
  b: MATS.b.clone(),
};
SEL_MATS.w.emissive.set(0x1c7f93);
SEL_MATS.b.emissive.set(0x157388);

function makePiece(p) {
  const t = p.toLowerCase(), c = colorOf(p);
  const g = new THREE.Group();
  for (const part of PARTS[t]) {
    const m = new THREE.Mesh(part.geo, MATS[c]);
    m.position.set(part.x || 0, part.y || 0, part.z || 0);
    if (part.ry) m.rotation.y = part.ry;
    if (part.head) m.rotation.y = (c === 'w' ? Math.PI / 2 : -Math.PI / 2) + 0.55;
    if (part.dark) m.material = EYE_MAT[c];
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  g.userData.p = p;
  return g;
}
function setPieceMat(g, sel) {
  const c = colorOf(g.userData.p);
  g.children.forEach(m => { if (m.material !== EYE_MAT.w && m.material !== EYE_MAT.b) m.material = sel ? SEL_MATS[c] : MATS[c]; });
}

// ---- highlight ----
const hlGroup = new THREE.Group();
scene.add(hlGroup);
const flat = g => { g.rotateX(-Math.PI / 2); return g; };
const HL_GEO = {
  sq: flat(new THREE.PlaneGeometry(0.96, 0.96)),
  dot: flat(new THREE.CircleGeometry(0.14, 28)),
  ring: flat(new THREE.RingGeometry(0.37, 0.47, 36)),
};
const hlMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const HL_MAT = {
  sel: hlMat(0x28e8ff, 0.55), last: hlMat(0xffd93a, 0.33), check: hlMat(0xff2050, 0.7),
  dot: hlMat(0x28e8ff, 0.85), ring: hlMat(0xff4fa3, 0.9), hover: hlMat(0xffffff, 0.14),
};
const hoverMesh = new THREE.Mesh(HL_GEO.sq, HL_MAT.hover);
hoverMesh.visible = false;
hoverMesh.position.y = 0.006;
scene.add(hoverMesh);

// =====================================================================
// Animasi
// =====================================================================
const anims = [];
function animate(dur, fn, done) { anims.push({ t0: performance.now(), dur, fn, done }); }
const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
function tweenPiece(obj, to, arc = 0, dur = 300, done) {
  const from = obj.position.clone();
  animate(dur, k => {
    const e = ease(k);
    obj.position.lerpVectors(from, to, e);
    obj.position.y = Math.sin(Math.PI * k) * arc;
  }, done);
}
function vanish(obj) {
  const s0 = obj.scale.x;
  animate(260, k => { obj.scale.setScalar(s0 * (1 - k)); obj.position.y = k * 0.6; }, () => scene.remove(obj));
}

// =====================================================================
// State game
// =====================================================================
const G = {
  mode: null,          // 'local' | 'bot' | 'online'
  chess: new Chess(),
  myColor: 'w',
  view: 'w',
  level: LS.get('chess_level', 'medium'),
  sel: null,
  legal: [],
  lastMove: null,
  over: false,
  result: null,
  thinking: false,
  hover: null,
};
let pieceAt = new Array(64).fill(null);

function syncPieces() {
  for (const m of pieceAt) if (m) scene.remove(m);
  pieceAt = new Array(64).fill(null);
  G.chess.board.forEach((p, s) => {
    if (!p) return;
    const m = makePiece(p);
    m.position.copy(sqPos(s));
    m.userData.sq = s;
    scene.add(m);
    pieceAt[s] = m;
  });
}
function reconcile() {
  // pastikan tampilan 3D sama persis dengan papan (setelah animasi)
  G.chess.board.forEach((p, s) => {
    const m = pieceAt[s];
    if ((m ? m.userData.p : null) === p) return;
    if (m) scene.remove(m);
    pieceAt[s] = null;
    if (p) {
      const n = makePiece(p);
      n.position.copy(sqPos(s));
      n.userData.sq = s;
      scene.add(n);
      pieceAt[s] = n;
    }
  });
}

function animateMove(m, mover) {
  const mesh = pieceAt[m.from];
  const capSq = m.flag === 'ep' ? m.to + (mover === 'w' ? -8 : 8) : m.to;
  const cap = pieceAt[capSq];
  if (cap && cap !== mesh) { pieceAt[capSq] = null; vanish(cap); }
  pieceAt[m.from] = null;
  if (!mesh) { reconcile(); return; }
  pieceAt[m.to] = mesh;
  mesh.userData.sq = m.to;
  setPieceMat(mesh, false);
  const isKnight = m.p.toLowerCase() === 'n';
  tweenPiece(mesh, sqPos(m.to), isKnight ? 0.9 : 0.25, isKnight ? 380 : 300, reconcile);
  if (m.flag === 'k' || m.flag === 'q') {
    const rf = m.flag === 'k' ? m.to + 1 : m.to - 2, rt = m.flag === 'k' ? m.to - 1 : m.to + 1;
    const rook = pieceAt[rf];
    if (rook) {
      pieceAt[rf] = null;
      pieceAt[rt] = rook;
      rook.userData.sq = rt;
      tweenPiece(rook, sqPos(rt), 0.5, 360);
    }
  }
}

function refreshHL() {
  while (hlGroup.children.length) hlGroup.remove(hlGroup.children[0]);
  const add = (geo, mat, s, y = 0.004) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(sqPos(s)).setY(y);
    hlGroup.add(m);
    return m;
  };
  if (G.lastMove) { add(HL_GEO.sq, HL_MAT.last, G.lastMove.from); add(HL_GEO.sq, HL_MAT.last, G.lastMove.to); }
  if (G.mode && G.chess.inCheck()) add(HL_GEO.sq, HL_MAT.check, G.chess.kings[G.chess.turn], 0.008).userData.pulse = true;
  pieceAt.forEach(m => m && setPieceMat(m, false));
  if (G.sel !== null) {
    add(HL_GEO.sq, HL_MAT.sel, G.sel, 0.01);
    if (pieceAt[G.sel]) setPieceMat(pieceAt[G.sel], true);
    const seen = new Set();
    for (const m of G.legal) {
      if (m.from !== G.sel || seen.has(m.to)) continue;
      seen.add(m.to);
      if (m.cap) add(HL_GEO.ring, HL_MAT.ring, m.to, 0.012);
      else add(HL_GEO.dot, HL_MAT.dot, m.to, 0.012);
    }
  }
}

// =====================================================================
// Kamera
// =====================================================================
function camDist() {
  const a = camera.aspect;
  const portrait = a < 1;
  return { r: Math.min(34, Math.max(12.5, 5.1 / (Math.tan((camera.fov * Math.PI) / 360) * a))), phi: portrait ? 0.6 : 0.78 };
}
function setView(color, instant) {
  G.view = color;
  orientLabels(color);
  const { r, phi } = camDist();
  const target = new THREE.Spherical(r, phi, color === 'w' ? 0 : Math.PI);
  controls.maxDistance = r * 1.5;
  if (instant) { camera.position.setFromSpherical(target); return; }
  const from = new THREE.Spherical().setFromVector3(camera.position);
  let dTheta = target.theta - from.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  const f0 = { r: from.radius, p: from.phi, t: from.theta };
  animate(700, k => {
    const e = ease(k);
    camera.position.setFromSpherical(new THREE.Spherical(f0.r + (r - f0.r) * e, f0.p + (phi - f0.p) * e, f0.t + dTheta * e));
  });
  updateBars();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  controls.maxDistance = camDist().r * 1.5;
}
window.addEventListener('resize', () => { resize(); if (G.mode) setView(G.view, false); });
resize();
setView('w', true);

// =====================================================================
// Input (klik petak / bidak)
// =====================================================================
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
function pickSquare(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const objs = squares.concat(pieceAt.filter(Boolean));
  const hit = ray.intersectObjects(objs, true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && o.userData.sq === undefined) o = o.parent;
  return o ? o.userData.sq : null;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; Sound.unlock(); });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 8) return;
  const s = pickSquare(e);
  if (s !== null) onSquare(s);
});
renderer.domElement.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || !G.mode) { hoverMesh.visible = false; return; }
  const s = pickSquare(e);
  hoverMesh.visible = s !== null && canMove();
  if (s !== null) hoverMesh.position.copy(sqPos(s)).setY(0.006);
  renderer.domElement.style.cursor = s !== null && canMove() && (G.legal.some(m => m.from === s || (G.sel !== null && m.from === G.sel && m.to === s))) ? 'pointer' : 'default';
});

function canMove() {
  if (!G.mode || G.over) return false;
  if (G.mode === 'local') return true;
  if (G.mode === 'bot') return !G.thinking && G.chess.turn === G.myColor;
  return Online.canMove();
}

function onSquare(s) {
  if (!canMove()) return;
  if (G.sel !== null) {
    const cands = G.legal.filter(m => m.from === G.sel && m.to === s);
    if (cands.length > 1) { askPromotion(cands); return; }
    if (cands.length === 1) { playMove(cands[0]); return; }
  }
  const p = G.chess.board[s];
  if (p && colorOf(p) === G.chess.turn && G.sel !== s && G.legal.some(m => m.from === s)) {
    G.sel = s;
    Sound.select();
  } else G.sel = null;
  refreshHL();
}

function askPromotion(cands) {
  const box = $('promoChoices');
  box.innerHTML = '';
  for (const t of 'qrbn') {
    const m = cands.find(x => x.promo.toLowerCase() === t);
    const b = document.createElement('button');
    b.textContent = G.chess.turn === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' }[t] : GLYPH[t];
    b.onclick = () => { hideOverlay(); playMove(m); };
    box.appendChild(b);
  }
  showCard('promoCard');
}

// =====================================================================
// Alur permainan
// =====================================================================
function playMove(m, opts = {}) {
  const mover = G.chess.turn;
  const san = G.chess.play(m);
  G.sel = null;
  G.lastMove = m;
  animateMove(m, mover);
  if (san.endsWith('+') || san.endsWith('#')) { Sound.check(); } else if (m.cap) Sound.capture(); else Sound.move();
  const st = afterPosition();
  if (G.mode === 'online' && !opts.remote) Online.sendMove(m, st);
  if (G.mode === 'bot' && !G.over && G.chess.turn !== G.myColor) botMove();
  return st;
}

function afterPosition(silent) {
  const st = G.chess.status();
  G.legal = st.over ? [] : st.legal;
  refreshHL();
  renderMoves();
  updateBars();
  if (!silent && st.check && !st.over) toast('SKAK!', 'check');
  if (st.over && !G.over) endGame(st.result, st.reason);
  return st;
}

function newGame(mode, opts = {}) {
  cancelBot();
  G.mode = mode;
  G.chess = new Chess();
  G.sel = null;
  G.lastMove = null;
  G.over = false;
  G.result = null;
  G.thinking = false;
  if (mode === 'bot') {
    G.level = opts.level || G.level;
    G.myColor = opts.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : (opts.color || 'w');
  } else if (mode === 'local') G.myColor = 'w';
  else G.myColor = opts.color || 'w';
  syncPieces();
  hideOverlay();
  document.body.classList.remove('panel-open');
  $('hud').hidden = false;
  $('btnHome').hidden = false;
  $('btnPanel').hidden = false;
  $('offerBar').hidden = true;
  $('chat').hidden = mode !== 'online';
  $('btnUndo').hidden = mode === 'online';
  $('btnDraw').hidden = mode !== 'online';
  $('btnResign').hidden = mode === 'local';
  $('btnClaim').hidden = true;
  $('modeLabel').textContent = mode === 'bot' ? `VS BOT · ${LEVEL_NAME[G.level].toUpperCase()}` : mode === 'local' ? '2 PEMAIN' : 'ONLINE';
  controls.autoRotate = false;
  setView(G.myColor);
  afterPosition(true);
  Sound.start();
  if (mode === 'bot' && G.myColor === 'b') botMove();
}

function endGame(result, reason) {
  if (G.over) return;
  G.over = true;
  G.result = { result, reason };
  G.sel = null;
  cancelBot();
  refreshHL();
  updateBars();
  const me = G.mode === 'local' ? null : G.myColor;
  let title, cls, icon;
  if (result === 'd') { title = 'REMIS'; cls = 'draw'; icon = '½'; }
  else if (!me) { title = result === 'w' ? 'PUTIH MENANG' : 'HITAM MENANG'; cls = 'win'; icon = result === 'w' ? '♔' : '♚'; }
  else if (result === me) { title = 'KAMU MENANG!'; cls = 'win'; icon = '🏆'; }
  else { title = 'KAMU KALAH'; cls = 'lose'; icon = '♚'; }
  let why = REASON[reason] || reason;
  if (result === 'd' && reason === 'timeout') why = 'Waktu habis, tapi lawan tidak punya bidak cukup untuk mat';
  else if (reason === 'resign' || reason === 'timeout') why = `${result === 'w' ? 'Hitam' : 'Putih'} ${reason === 'resign' ? 'menyerah' : 'kehabisan waktu'}`;
  $('overTitle').textContent = title;
  $('overTitle').className = cls;
  $('overIcon').textContent = icon;
  $('overReason').textContent = why;
  $('overRematch').hidden = G.mode !== 'online';
  $('overRematch').disabled = false;
  $('overRematch').textContent = 'REMATCH';
  $('rematchInfo').hidden = true;
  $('overAgain').hidden = G.mode === 'online';
  $('overMenu').textContent = G.mode === 'online' ? 'KE LOBBY' : 'MENU';
  $('offerBar').hidden = true;
  if (cls === 'win') Sound.win(); else if (cls === 'lose') Sound.lose(); else Sound.notify();
  setTimeout(() => { if (G.over && G.result && G.result.reason === reason) showCard('overCard'); }, 900);
}

function takeback() {
  if (G.mode === 'online' || !G.chess.hist.length) return;
  cancelBot();
  G.thinking = false;
  if (G.mode === 'bot') {
    G.chess.takeback();
    if (G.chess.turn !== G.myColor && G.chess.hist.length) G.chess.takeback();
  } else G.chess.takeback();
  G.over = false;
  G.result = null;
  G.sel = null;
  const h = G.chess.hist[G.chess.hist.length - 1];
  G.lastMove = h ? h.m : null;
  hideOverlay();
  syncPieces();
  afterPosition(true);
  if (G.mode === 'bot' && G.chess.turn !== G.myColor) botMove();
}

function goMenu() {
  cancelBot();
  G.mode = null;
  G.over = false;
  G.sel = null;
  G.lastMove = null;
  G.chess = new Chess();
  G.legal = [];
  syncPieces();
  refreshHL();
  $('hud').hidden = true;
  $('btnHome').hidden = true;
  $('btnPanel').hidden = true;
  $('offerBar').hidden = true;
  document.body.classList.remove('panel-open');
  controls.autoRotate = true;
  $('goResume').hidden = !LS.get('chess_room', '');
  showCard('menuCard');
}

// =====================================================================
// Bot (Web Worker jika bisa, fallback ke main thread)
// =====================================================================
let worker = null, botReq = 0;
const pending = new Map();
try {
  worker = new Worker('engine.js');
  worker.onmessage = e => { const cb = pending.get(e.data.id); pending.delete(e.data.id); if (cb) cb(e.data.move); };
  worker.onerror = () => {
    worker = null;
    for (const [id, cb] of pending) cb(bestMove(cb.fen, cb.level), id);
    pending.clear();
  };
} catch (e) { worker = null; }

function cancelBot() { botReq++; pending.clear(); G.thinking = false; }
function botMove() {
  G.thinking = true;
  updateBars();
  const id = ++botReq, fen = G.chess.fen(), level = G.level, t0 = performance.now();
  const finish = mv => {
    if (id !== botReq || G.mode !== 'bot' || G.over) return;
    setTimeout(() => {
      if (id !== botReq) return;
      G.thinking = false;
      const m = G.chess.fromUci(mv);
      if (m) playMove(m); else updateBars();
    }, Math.max(0, 550 - (performance.now() - t0)));
  };
  if (worker) {
    finish.fen = fen;
    finish.level = level;
    pending.set(id, finish);
    worker.postMessage({ id, fen, level });
  } else setTimeout(() => finish(bestMove(fen, level)), 60);
}

// =====================================================================
// HUD
// =====================================================================
function capturedBy(color) {
  // bidak lawan yang sudah dimakan oleh `color`
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const cnt = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const opp = other(color);
  for (const p of G.chess.board) if (p && colorOf(p) === opp && p.toLowerCase() !== 'k') cnt[p.toLowerCase()]++;
  let s = '';
  for (const t of ['q', 'r', 'b', 'n', 'p']) s += GLYPH[t].repeat(Math.max(0, start[t] - cnt[t]));
  return s;
}
function material(color) {
  let v = 0;
  for (const p of G.chess.board) if (p && colorOf(p) === color) v += ChessEngine.VAL[p.toLowerCase()];
  return v;
}
function playerInfo(color) {
  if (G.mode === 'bot') {
    if (color === G.myColor) return { name: LS.get('chess_name', 'Kamu') || 'Kamu', tag: 'Kamu' };
    return { name: `🤖 Bot ${LEVEL_NAME[G.level]}`, tag: G.thinking ? 'berpikir…' : '', cls: G.thinking ? 'think' : '' };
  }
  if (G.mode === 'online') return Online.playerInfo(color);
  return { name: color === 'w' ? 'Putih' : 'Hitam', tag: '' };
}
function updateBars() {
  if (!G.mode) return;
  const bars = { [G.view]: $('barBottom'), [other(G.view)]: $('barTop') };
  const clocks = G.mode === 'online' ? Online.clocks() : null;
  for (const c of ['w', 'b']) {
    const el = bars[c], info = playerInfo(c);
    el.querySelector('.pdot').className = 'pdot ' + c;
    el.querySelector('.pname').textContent = info.name;
    const tag = el.querySelector('.ptag');
    tag.textContent = info.tag || '';
    tag.className = 'ptag ' + (info.cls || '');
    const diff = Math.round((material(c) - material(other(c))) / 100);
    el.querySelector('.pcap').innerHTML = esc(capturedBy(c)) + (diff > 0 ? `<b>+${diff}</b>` : '');
    el.classList.toggle('active', !G.over && G.chess.turn === c);
    const ck = el.querySelector('.pclock');
    ck.hidden = !clocks;
    if (clocks) {
      ck.textContent = fmtClock(clocks[c]);
      ck.classList.toggle('low', clocks[c] < 20000 && G.chess.turn === c && !G.over);
    }
  }
  $('turnLabel').textContent = G.over ? 'Selesai' : (G.chess.turn === 'w' ? 'Giliran Putih' : 'Giliran Hitam');
  $('btnUndo').disabled = !G.chess.hist.length;
}
function renderMoves() {
  const box = $('moves');
  const h = G.chess.hist;
  let html = '';
  for (let i = 0; i < h.length; i += 2) {
    html += `<div class="n">${i / 2 + 1}.</div><span class="${i === h.length - 1 ? 'last' : ''}">${esc(h[i].san)}</span>` +
      `<span class="${i + 1 === h.length - 1 ? 'last' : ''}">${h[i + 1] ? esc(h[i + 1].san) : ''}</span>`;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
function toast(text, cls = 'info') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  $('toast').appendChild(d);
  setTimeout(() => d.remove(), 2000);
}

// =====================================================================
// Overlay
// =====================================================================
const CARDS = ['menuCard', 'botCard', 'lobbyCard', 'searchCard', 'waitCard', 'promoCard', 'confirmCard', 'overCard'];
function showCard(id) {
  $('overlay').classList.remove('hidden');
  for (const c of CARDS) $(c).hidden = c !== id;
}
function hideOverlay() { $('overlay').classList.add('hidden'); }
function confirmBox(title, text, yes) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  const prev = CARDS.find(c => !$(c).hidden && !$('overlay').classList.contains('hidden'));
  $('confirmYes').onclick = () => { hideOverlay(); yes(); };
  $('confirmNo').onclick = () => (prev ? showCard(prev) : hideOverlay());
  showCard('confirmCard');
}
function segment(id, value, onChange) {
  const el = $(id);
  const set = v => { el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); if (onChange) onChange(v); };
  el.addEventListener('click', e => { const b = e.target.closest('button'); if (b) set(b.dataset.v); });
  set(value);
  return () => el.querySelector('button.on').dataset.v;
}

// =====================================================================
// Online (Firebase Realtime Database)
// =====================================================================
const Online = (() => {
  let db = null, offset = 0, connected = false;
  let uid = LS.get('chess_uid', '');
  if (!uid) { uid = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); LS.set('chess_uid', uid); }
  let lobbyRooms = null, presenceRef = null, presenceCount = null;
  let roomRef = null, room = null, code = null, moves = [];
  let search = null;            // state find match
  let oppGoneAt = 0, lastClaimTry = 0, chatSeen = 0, waitingShown = false;

  const now = () => Date.now() + offset;
  const R = p => db.ref('chess/' + p);
  const name = () => (LS.get('chess_name', '') || 'Pemain').slice(0, 16);

  function lobbyError(msg) {
    const e = $('lobbyError');
    e.hidden = !msg;
    e.innerHTML = msg || '';
    if (msg) { $('connDot').className = 'err'; }
  }
  function permError(err) {
    console.error(err);
    lobbyError(`<b>Tidak bisa mengakses database.</b><br>${esc(err && err.message ? err.message : err)}<br>
      Pastikan Realtime Database sudah dibuat, <code>databaseURL</code> di <i>firebase-config.js</i> benar,
      dan Rules mengizinkan baca/tulis ke node <code>chess</code> (lihat README).`);
  }

  function init() {
    if (db) return true;
    if (!window.firebase || !window.CHESS_FIREBASE_CONFIG) { permError('Firebase SDK gagal dimuat (cek koneksi internet).'); return false; }
    try {
      const app = firebase.apps.find(a => a.name === 'chess') || firebase.initializeApp(window.CHESS_FIREBASE_CONFIG, 'chess');
      db = app.database();
    } catch (e) { permError(e); return false; }
    db.ref('.info/serverTimeOffset').on('value', s => { offset = s.val() || 0; });
    db.ref('.info/connected').on('value', s => {
      connected = !!s.val();
      $('connDot').className = connected ? 'on' : '';
      updateConnText();
      if (connected) {
        presenceRef = R('presence/' + uid);
        presenceRef.onDisconnect().remove();
        presenceRef.set({ n: name(), t: firebase.database.ServerValue.TIMESTAMP }).catch(permError);
      }
    });
    R('presence').on('value', s => { presenceCount = s.numChildren(); updateConnText(); }, permError);
    return true;
  }
  function updateConnText() {
    $('connText').textContent = !connected ? 'Menghubungkan…' : `Online · ${presenceCount ?? 1} pemain`;
  }

  // ---------- lobby ----------
  function openLobby() {
    showCard('lobbyCard');
    lobbyError('');
    if (!init()) return;
    if (presenceRef) presenceRef.update({ n: name() }).catch(() => {});
    if (!lobbyRooms) {
      lobbyRooms = R('rooms').orderByChild('status').equalTo('waiting');
      lobbyRooms.on('value', renderRooms, permError);
    }
    // bersihkan room lama (> 3 jam)
    R('rooms').orderByChild('created').endAt(now() - 3 * 3600e3).limitToFirst(20).once('value')
      .then(s => s.forEach(c => { c.ref.remove(); }))
      .catch(() => {});
  }
  function closeLobby() {
    if (lobbyRooms) { lobbyRooms.off(); lobbyRooms = null; }
  }
  function renderRooms(snap) {
    const list = [];
    snap.forEach(c => {
      const r = c.val();
      if (r && !r.priv && r.host !== uid && r.created > now() - 30 * 60e3) list.push(r);
    });
    list.sort((a, b) => b.created - a.created);
    const box = $('roomList');
    if (!list.length) { box.innerHTML = '<div class="empty">Belum ada room terbuka. Buat room atau tekan “Cari Lawan”.</div>'; return; }
    box.innerHTML = list.map(r => `
      <div class="room">
        <div class="who"><b>${esc(r.hn || 'Pemain')}</b><span>${r.quick ? 'Cari lawan · ' : ''}host main ${r.hc === 'w' ? '♔ putih' : '♚ hitam'}</span></div>
        <span class="tc">${r.tc ? `${r.tc}+${r.inc}` : '∞'}</span>
        <button class="mini accent" data-join="${esc(r.code)}">Gabung</button>
      </div>`).join('');
  }

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += A[(Math.random() * A.length) | 0];
    return s;
  }
  async function createRoom(opt) {
    const hc = opt.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : opt.color;
    for (let tries = 0; tries < 5; tries++) {
      const c = genCode();
      const data = {
        code: c, status: 'waiting', quick: !!opt.quick, priv: !!opt.priv, tc: opt.tc, inc: opt.inc,
        created: now(), host: uid, hn: name(), hc, [hc]: { id: uid, n: name() },
      };
      const ref = R('rooms/' + c);
      const res = await ref.transaction(cur => (cur ? undefined : data));
      if (res.committed) { ref.onDisconnect().remove(); return data; }
    }
    throw new Error('Gagal membuat room, coba lagi.');
  }
  async function tryJoin(c) {
    const ref = R('rooms/' + c);
    let seat = null;
    const res = await ref.transaction(r => {
      if (!r) return r;
      if (r.status !== 'waiting' || r.host === uid) return;
      seat = r.w ? (r.b ? null : 'b') : 'w';
      if (!seat) return;
      r[seat] = { id: uid, n: name() };
      r.status = 'playing';
      r.start = now();
      return r;
    });
    const v = res.snapshot.val();
    if (res.committed && v && v.status === 'playing' && v[seat] && v[seat].id === uid) { enterRoom(c); return true; }
    return false;
  }
  async function joinByCode(c) {
    c = (c || '').trim().toUpperCase();
    if (!c) return;
    if (!init()) return;
    try {
      const s = await R('rooms/' + c).once('value');
      const r = s.val();
      if (!r) { lobbyError('Room <b>' + esc(c) + '</b> tidak ditemukan.'); LS.del('chess_room'); showCard('lobbyCard'); return; }
      const mine = (r.w && r.w.id === uid) || (r.b && r.b.id === uid);
      if (mine && r.status !== 'finished') { enterRoom(c); return; }
      if (r.status === 'waiting' && await tryJoin(c)) return;
      lobbyError('Room <b>' + esc(c) + '</b> sudah penuh atau selesai.');
      if (mine) LS.del('chess_room');
      showCard('lobbyCard');
    } catch (e) { permError(e); showCard('lobbyCard'); }
  }

  // ---------- find match ----------
  async function findMatch(tc, inc) {
    if (!init()) return;
    cancelSearch();
    const st = { tc, inc, mine: null, mineRef: null, timer: null, t0: Date.now(), alive: true };
    search = st;
    $('searchTc').textContent = tc ? `${tc}+${inc}` : '∞ santai';
    showCard('searchCard');
    const watchMine = () => {
      st.mineRef.on('value', s => {
        const r = s.val();
        if (r && r.status === 'playing' && st.alive) { st.alive = false; st.mineRef.off(); search = null; enterRoom(r.code); }
      });
    };
    const scan = async () => {
      const snap = await R('rooms').orderByChild('status').equalTo('waiting').once('value');
      const list = [];
      snap.forEach(c => {
        const r = c.val();
        if (r && r.quick && r.tc === tc && r.inc === inc && r.host !== uid && r.created > now() - 10 * 60e3) list.push(r);
      });
      return list.sort((a, b) => a.created - b.created || (a.code < b.code ? -1 : 1));
    };
    const loop = async () => {
      if (!st.alive) return;
      try {
        let list = await scan();
        if (!st.alive) return;
        if (st.mine) {
          // kalau ada pencari yang lebih dulu, tinggalkan room sendiri dan gabung ke sana
          list = list.filter(r => r.created < st.mine.created || (r.created === st.mine.created && r.code < st.mine.code));
          if (list.length) {
            const gone = await dropMine(st);
            if (!gone) return;
          }
        }
        for (const r of list) {
          if (!st.alive) return;
          if (await tryJoin(r.code)) { st.alive = false; search = null; return; }
        }
        if (!st.alive) return;
        if (!st.mine) {
          st.mine = await createRoom({ quick: true, tc, inc, color: 'r' });
          st.mineRef = R('rooms/' + st.mine.code);
          watchMine();
        }
      } catch (e) { permError(e); showCard('lobbyCard'); st.alive = false; search = null; return; }
      st.timer = setTimeout(loop, 2200 + Math.random() * 1200);
    };
    loop();
  }
  // hapus room milik sendiri; false jika ternyata sudah ada yang gabung (game dimulai)
  async function dropMine(st) {
    st.mineRef.off();
    const ref = st.mineRef;
    const res = await ref.transaction(r => { if (!r) return r; if (r.status !== 'waiting') return; return null; });
    const v = res.snapshot.val();
    if (v && v.status === 'playing') { st.alive = false; search = null; enterRoom(v.code); return false; }
    ref.onDisconnect().cancel();
    st.mine = null;
    st.mineRef = null;
    return true;
  }
  function cancelSearch() {
    const st = search;
    search = null;
    if (!st) return;
    st.alive = false;
    clearTimeout(st.timer);
    if (st.mineRef) dropMine(st).catch(() => {});
  }
  function searchTick() {
    if (!search) return;
    const s = Math.floor((Date.now() - search.t0) / 1000);
    $('searchTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- room pribadi ----------
  async function hostRoom(opt) {
    if (!init()) return;
    try {
      const r = await createRoom(opt);
      enterRoom(r.code);
    } catch (e) { permError(e); }
  }

  // ---------- di dalam room ----------
  function enterRoom(c) {
    leaveRoom(true);
    closeLobby();
    code = c;
    room = null;
    moves = [];
    chatSeen = 0;
    oppGoneAt = 0;
    waitingShown = false;
    LS.set('chess_room', c);
    roomRef = R('rooms/' + c);
    const conn = roomRef.child('conn/' + uid);
    conn.set(true).catch(() => {});
    conn.onDisconnect().set(false);
    $('chatLog').innerHTML = '';
    newGame('online', { color: 'w' });
    roomRef.on('value', onRoom, permError);
  }

  function onRoom(snap) {
    const r = snap.val();
    if (!r || !r.status) {
      if (G.mode === 'online' && !G.over) { toast('Room ditutup'); }
      if (G.mode === 'online' && !G.over) { leaveRoom(true); LS.del('chess_room'); goMenu(); openLobby(); }
      return;
    }
    const prev = room;
    room = r;
    const me = r.w && r.w.id === uid ? 'w' : r.b && r.b.id === uid ? 'b' : null;
    if (r.status === 'waiting') {
      if (!waitingShown) {
        waitingShown = true;
        $('waitCode').textContent = r.code;
        showCard('waitCard');
      }
      G.myColor = r.hc;
      if (G.view !== r.hc) setView(r.hc);
      updateBars();
      return;
    }
    if (!me) { toast('Room sudah penuh'); leaveRoom(true); goMenu(); openLobby(); return; }
    if (G.myColor !== me) { G.myColor = me; setView(me); }
    moves = !r.moves ? [] : Array.isArray(r.moves) ? r.moves.filter(Boolean) : Object.keys(r.moves).sort((a, b) => a - b).map(k => r.moves[k]);
    if (!prev || prev.status === 'waiting') {
      roomRef.onDisconnect().cancel();
      roomRef.child('conn/' + uid).onDisconnect().set(false);
      if (r.status === 'playing') hideOverlay();
      if (waitingShown || (r.status === 'playing' && !moves.length)) { toast('Lawan ditemukan!'); Sound.start(); }
      waitingShown = false;
      sysChat(`Kamu main sebagai ${me === 'w' ? 'Putih ♔' : 'Hitam ♚'}. Semoga beruntung!`);
    }
    // langkah
    syncMoves();
    // hasil
    if (r.status === 'finished' && r.result && !G.over) endGame(r.result.w, r.result.r);
    // tawaran remis
    const opp = r[other(me)];
    const bar = $('offerBar');
    if (r.status === 'playing' && r.draw && r.draw !== uid) {
      if (bar.hidden) Sound.notify();
      $('offerText').textContent = `${opp ? opp.n : 'Lawan'} menawarkan remis`;
      bar.hidden = false;
    } else bar.hidden = true;
    $('btnDraw').disabled = r.status !== 'playing' || r.draw === uid;
    // koneksi lawan
    const oppOff = opp && r.conn && r.conn[opp.id] === false;
    if (oppOff && !oppGoneAt) oppGoneAt = Date.now();
    if (!oppOff) oppGoneAt = 0;
    // chat
    renderChat(r.chat);
    // rematch
    if (r.status === 'finished') handleRematch(r, me, opp, prev);
    updateBars();
  }

  function syncMoves() {
    const c = G.chess, n = c.hist.length;
    const sameAt = i => uci(c.hist[i].m) === moves[i].u;
    if (moves.length === n && (n === 0 || sameAt(n - 1))) return;
    if (moves.length === n + 1 && (n === 0 || sameAt(n - 1))) {
      const m = c.fromUci(moves[n].u);
      if (m) { playMove(m, { remote: true }); return; }
    }
    // replay penuh (masuk ulang / beda sinkron)
    G.chess = new Chess();
    for (const mv of moves) { const m = G.chess.fromUci(mv.u); if (!m) break; G.chess.play(m); }
    const h = G.chess.hist[G.chess.hist.length - 1];
    G.lastMove = h ? h.m : null;
    G.sel = null;
    syncPieces();
    afterPosition(true);
  }

  function clocks() {
    if (!room || !room.tc) return null;
    const full = room.tc * 60000;
    const last = moves[moves.length - 1];
    let w = last ? last.wt : full, b = last ? last.bt : full;
    if (room.status === 'playing' && moves.length >= 2 && !G.over) {
      const el = now() - last.t;
      if (G.chess.turn === 'w') w -= el; else b -= el;
    }
    return { w, b };
  }

  function sendMove(m, st) {
    if (!roomRef || !room) return;
    const n = G.chess.hist.length - 1;
    const prevMv = moves[n - 1];
    const full = room.tc * 60000, inc = (room.inc || 0) * 1000;
    let wt = prevMv ? prevMv.wt : full, bt = prevMv ? prevMv.bt : full;
    if (room.tc && n >= 2) {
      const used = now() - prevMv.t;
      if (G.myColor === 'w') wt = wt - used + inc; else bt = bt - used + inc;
    }
    const entry = { u: uci(m), t: now(), wt: Math.round(wt), bt: Math.round(bt) };
    moves[n] = entry;
    const upd = { ['moves/' + n]: entry, draw: null };
    if (st.over) { upd.status = 'finished'; upd.result = { w: st.result, r: st.reason }; }
    roomRef.update(upd).catch(permError);
  }

  function finish(winner, reason, guard) {
    if (!roomRef) return;
    roomRef.transaction(r => {
      if (!r) return r;
      if (r.status !== 'playing') return;
      if (guard && !guard(r)) return;
      r.status = 'finished';
      r.result = { w: winner, r: reason };
      r.draw = null;
      return r;
    }).catch(() => {});
  }

  function tick() {
    searchTick();
    if (G.mode !== 'online' || !room || room.status !== 'playing' || G.over) { $('btnClaim').hidden = true; return; }
    const ck = clocks();
    if (ck) {
      const t = G.chess.turn;
      if (ck[t] <= 0 && Date.now() - lastClaimTry > 2500) {
        lastClaimTry = Date.now();
        const count = moves.length;
        const win = G.chess.insufficient() ? 'd' : other(t);
        finish(win, 'timeout', r => (r.moves ? Object.keys(r.moves).length : 0) === count);
      }
    }
    const canClaim = oppGoneAt && Date.now() - oppGoneAt > 30000;
    $('btnClaim').hidden = !canClaim;
  }

  function playerInfo(color) {
    const p = room && room[color];
    if (!p) return { name: room && room.status === 'waiting' ? 'Menunggu lawan…' : '—', tag: '' };
    const me = p.id === uid;
    const off = !me && room.conn && room.conn[p.id] === false;
    const secs = oppGoneAt ? Math.floor((Date.now() - oppGoneAt) / 1000) : 0;
    return { name: p.n || 'Pemain', tag: me ? 'Kamu' : off ? `terputus ${secs}s` : 'online', cls: off ? 'warn' : '' };
  }

  // ---------- chat ----------
  function renderChat(chat) {
    const list = chat ? Object.values(chat).sort((a, b) => a.t - b.t).slice(-50) : [];
    const log = $('chatLog');
    const sys = [...log.querySelectorAll('.sys')].map(e => e.outerHTML).join('');
    log.innerHTML = sys + list.map(m => `<div class="${m.id === uid ? 'me' : ''}"><b>${esc(m.n)}:</b> ${esc(m.m)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
    const fromOpp = list.filter(m => m.id !== uid).length;
    if (fromOpp > chatSeen) {
      Sound.notify();
      if (!document.body.classList.contains('panel-open')) $('chatBadge').hidden = false;
      chatSeen = fromOpp;
    }
  }
  function sysChat(text) {
    const d = document.createElement('div');
    d.className = 'sys';
    d.textContent = text;
    $('chatLog').prepend(d);
  }
  function sendChat(text) {
    text = text.trim().slice(0, 200);
    if (!text || !roomRef) return;
    roomRef.child('chat').push({ id: uid, n: name(), m: text, t: now() }).catch(permError);
  }

  // ---------- akhir game / rematch ----------
  function handleRematch(r, me, opp, prev) {
    const rm = r.rm || {};
    const info = $('rematchInfo');
    if (r.next) {
      const next = r.next;
      setTimeout(() => { if (code !== next) enterRoom(next); }, 50);
      return;
    }
    const oppLeft = opp && r.left && r.left[opp.id];
    if (oppLeft) {
      info.hidden = false;
      info.textContent = 'Lawan sudah keluar dari room.';
      $('overRematch').disabled = true;
    } else if (opp && rm[opp.id] && !rm[uid]) {
      info.hidden = false;
      info.textContent = `${opp.n} mengajak rematch!`;
      const before = prev && prev.rm && prev.rm[opp.id];
      if (!before) { Sound.notify(); if (G.over) showCard('overCard'); }
    } else if (rm[uid]) {
      info.hidden = false;
      info.textContent = 'Menunggu lawan menerima rematch…';
      $('overRematch').disabled = true;
    }
    if (opp && rm[uid] && rm[opp.id] && r.host === uid && !r.next) {
      const c = genCode();
      const data = {
        code: c, status: 'playing', quick: false, priv: true, tc: r.tc, inc: r.inc, created: now(), start: now(),
        host: uid, hn: name(), hc: other(me), w: r.b, b: r.w,
      };
      R('rooms/' + c).set(data).then(() => roomRef.update({ next: c })).catch(permError);
    }
  }
  function rematch() {
    if (!roomRef) return;
    roomRef.child('rm/' + uid).set(true).catch(permError);
  }

  function leaveRoom(silent) {
    if (!roomRef) return;
    const ref = roomRef, r = room;
    ref.off();
    ref.child('conn/' + uid).onDisconnect().cancel();
    ref.onDisconnect().cancel();
    if (r && r.status === 'waiting' && r.host === uid) ref.remove();
    else if (r && r.status === 'finished') {
      const opp = r[other(G.myColor)];
      if (opp && r.left && r.left[opp.id]) ref.remove();
      else ref.child('left/' + uid).set(true).catch(() => {});
      LS.del('chess_room');
    } else if (r && r.status === 'playing' && !silent) {
      ref.child('conn/' + uid).set(false).catch(() => {});
    }
    roomRef = null;
    room = null;
    code = null;
    moves = [];
  }

  return {
    init, openLobby, closeLobby, findMatch, cancelSearch, hostRoom, tryJoin, joinByCode, leaveRoom,
    sendMove, clocks, tick, playerInfo, sendChat, rematch,
    get uid() { return uid; },
    get code() { return code; },
    get room() { return room; },
    canMove() { return !!room && room.status === 'playing' && G.chess.turn === G.myColor; },
    resign() { finish(other(G.myColor), 'resign'); },
    offerDraw() { if (roomRef) roomRef.update({ draw: uid }); toast('Tawaran remis dikirim'); },
    answerDraw(yes) {
      if (!roomRef) return;
      if (yes) finish('d', 'agreement', r => r.draw && r.draw !== uid);
      else roomRef.update({ draw: null });
      $('offerBar').hidden = true;
    },
    claimWin() {
      const opp = room && room[other(G.myColor)];
      if (opp) finish(G.myColor, 'abandon', r => r.conn && r.conn[opp.id] === false);
    },
    waitingCode() { return room && room.status === 'waiting' ? room.code : null; },
  };
})();

// =====================================================================
// Tombol & menu
// =====================================================================
const nameInput = $('nameInput');
nameInput.value = LS.get('chess_name', '') || 'Pemain' + Math.floor(100 + Math.random() * 900);
LS.set('chess_name', nameInput.value);
nameInput.addEventListener('input', () => LS.set('chess_name', nameInput.value.trim().slice(0, 16)));

const getBotLevel = segment('botLevel', G.level, v => { $('botLevelHint').textContent = LEVEL_HINT[v]; });
const getBotColor = segment('botColor', LS.get('chess_botcolor', 'w'));
const getTc = segment('tcSeg', LS.get('chess_tc', '3|2'), v => LS.set('chess_tc', v));
const getRoomColor = segment('roomColor', 'r');
const parseTc = () => getTc().split('|').map(Number);

$('goBot').onclick = () => showCard('botCard');
$('goLocal').onclick = () => newGame('local');
$('goOnline').onclick = () => Online.openLobby();
$('goResume').onclick = () => { Online.openLobby(); Online.joinByCode(LS.get('chess_room', '')); };
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = () => showCard(b.dataset.back); });
$('botStart').onclick = () => {
  const level = getBotLevel(), color = getBotColor();
  LS.set('chess_level', level);
  LS.set('chess_botcolor', color);
  newGame('bot', { level, color });
};

$('lobbyBack').onclick = () => { Online.closeLobby(); showCard('menuCard'); };
$('findBtn').onclick = () => { const [tc, inc] = parseTc(); Online.findMatch(tc, inc); };
$('searchCancel').onclick = () => { Online.cancelSearch(); showCard('lobbyCard'); };
$('createBtn').onclick = () => { const [tc, inc] = parseTc(); Online.hostRoom({ tc, inc, color: getRoomColor(), priv: $('roomPriv').checked }); };
$('joinForm').onsubmit = e => { e.preventDefault(); Online.joinByCode($('codeInput').value); };
$('roomList').addEventListener('click', async e => {
  const b = e.target.closest('[data-join]');
  if (!b) return;
  b.disabled = true;
  if (!(await Online.tryJoin(b.dataset.join))) { toast('Room sudah tidak tersedia'); b.disabled = false; }
});
$('waitCancel').onclick = () => { Online.leaveRoom(true); LS.del('chess_room'); goMenu(); Online.openLobby(); };
$('copyLink').onclick = () => {
  const c = Online.waitingCode();
  if (!c) return;
  const url = location.href.split(/[?#]/)[0] + '?room=' + c;
  const done = () => { $('copyLink').textContent = '✓ LINK TERSALIN'; setTimeout(() => { $('copyLink').textContent = '📋 SALIN LINK'; }, 1600); };
  if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: 'Main catur yuk!', url }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Salin link:', url));
  else prompt('Salin link:', url);
};
$('promoCancel').onclick = () => { hideOverlay(); G.sel = null; refreshHL(); };

$('btnHome').onclick = () => {
  if (G.mode === 'online' && Online.room && Online.room.status === 'playing' && !G.over) {
    confirmBox('KELUAR?', 'Game masih berjalan. Keluar berarti kamu menyerah.', () => { Online.resign(); Online.leaveRoom(); goMenu(); Online.openLobby(); });
  } else if (G.mode === 'online') { Online.leaveRoom(); goMenu(); Online.openLobby(); }
  else if (G.mode && G.chess.hist.length && !G.over) confirmBox('KE MENU?', 'Permainan saat ini akan dihentikan.', goMenu);
  else goMenu();
};
$('btnFlip').onclick = () => { if (G.mode) setView(other(G.view)); else controls.autoRotate = !controls.autoRotate; };
$('btnSound').onclick = () => { const on = Sound.toggle(); $('btnSound').textContent = on ? '🔊' : '🔇'; $('btnSound').classList.toggle('off', !on); };
$('btnSound').textContent = Sound.on ? '🔊' : '🔇';
$('btnPanel').onclick = () => { document.body.classList.toggle('panel-open'); $('chatBadge').hidden = true; };
$('btnUndo').onclick = takeback;
$('btnResign').onclick = () => {
  if (G.over) return;
  confirmBox('MENYERAH?', 'Kamu akan kalah di game ini.', () => {
    if (G.mode === 'online') Online.resign();
    else endGame(other(G.myColor), 'resign');
  });
};
$('btnDraw').onclick = () => Online.offerDraw();
$('btnClaim').onclick = () => Online.claimWin();
$('offerYes').onclick = () => Online.answerDraw(true);
$('offerNo').onclick = () => Online.answerDraw(false);
$('chatForm').onsubmit = e => { e.preventDefault(); Online.sendChat($('chatInput').value); $('chatInput').value = ''; };

$('overRematch').onclick = () => { Online.rematch(); $('overRematch').disabled = true; };
$('overAgain').onclick = () => (G.mode === 'bot' ? newGame('bot', { level: G.level, color: G.myColor }) : newGame('local'));
$('overView').onclick = hideOverlay;
$('overMenu').onclick = () => {
  if (G.mode === 'online') { Online.leaveRoom(); goMenu(); Online.openLobby(); } else goMenu();
};

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { G.sel = null; refreshHL(); }
  else if (e.key === 'f' || e.key === 'F') $('btnFlip').click();
  else if (e.key === 'm' || e.key === 'M') $('btnSound').click();
});

// =====================================================================
// Loop render
// =====================================================================
let lastHud = 0;
function frame(t) {
  requestAnimationFrame(frame);
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i];
    const k = Math.min(1, (t - a.t0) / a.dur);
    a.fn(k);
    if (k >= 1) { anims.splice(i, 1); if (a.done) a.done(); }
  }
  for (const m of hlGroup.children) if (m.userData.pulse) m.material.opacity = 0.45 + Math.sin(t / 160) * 0.25;
  if (t - lastHud > 200) {
    lastHud = t;
    Online.tick();
    if (G.mode === 'online') updateBars();
  }
  controls.update();
  renderer.render(scene, camera);
}

// start
syncPieces();
controls.autoRotate = true;
$('goResume').hidden = !LS.get('chess_room', '');
showCard('menuCard');
requestAnimationFrame(frame);
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  history.replaceState(null, '', location.pathname);
  Online.openLobby();
  Online.joinByCode(roomParam);
}
