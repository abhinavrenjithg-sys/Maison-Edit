/* Maison Edit — 3D avatar.
 * Builds a stylised figure in the browser (no AI service, no upload): body shaped by
 * height and size, the shopper's face from their photo, hair, and simple 3D versions
 * of the selected top, skirt, shoes and bag in the products' own colours.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const SIZE_W = { XS: .9, S: .95, M: 1, L: 1.07, XL: 1.14 };
// [radius, height] outlines, turned around the vertical axis
const TORSO = [[.150, .78], [.165, .86], [.156, .95], [.126, 1.03], [.134, 1.12], [.150, 1.22], [.150, 1.30], [.136, 1.36], [.090, 1.405], [.046, 1.43], [.046, 1.52]];
const LEG = [[.033, .04], [.036, .09], [.049, .26], [.040, .45], [.050, .55], [.068, .72], [.078, .84]];
const DEPTH = .68; // the torso is flatter front to back than side to side
const HEAD = { y: 1.6, x: .09, yr: .118, z: .1 };
const FALLBACK = {
  t1: '#ece6dc', t2: '#1d1d1f', t3: '#6e1c2a',
  k1: '#3b3b3e', k2: '#86a0c4', k3: '#e6dccb',
  s1: '#161616', s2: '#f1f0ec', s3: '#5a1622',
  g1: '#1a1a1a', g2: '#d9cfc0', g3: '#6b1a26'
};

const V2 = (r, y) => new THREE.Vector2(r, y);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function interp(prof, y) {
  if (y <= prof[0][1]) return prof[0][0];
  for (let i = 1; i < prof.length; i++) {
    const [r1, y1] = prof[i], [r0, y0] = prof[i - 1];
    if (y <= y1) return r0 + (r1 - r0) * (y - y0) / (y1 - y0);
  }
  return prof[prof.length - 1][0];
}
const torsoR = (y, w) => interp(TORSO, y) * (y < 1.4 ? w : 1);
const legR = (y, w) => interp(LEG, y) * Math.sqrt(w);
function mat(color, rough = .8, extra = {}) {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: 0, ...extra });
}
function between(geom, a, b, material) {
  const m = new THREE.Mesh(geom, material);
  m.position.copy(a.clone().add(b).multiplyScalar(.5));
  m.quaternion.setFromUnitVectors(V3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}
function armPoints(s, w, lift = 0) {
  return [V3(s * .172 * w, 1.34 - lift, 0), V3(s * .235 * w, .88, .02)];
}
function disposeTree(o) {
  o.traverse(n => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) [].concat(n.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}

/* ---------- body ---------- */
function faceTexture(st) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  if (st.face) {
    x.drawImage(st.face, 128 - 90, 2, 180, 240);
  } else {
    // a calm default face until the shopper adds their own
    x.fillStyle = 'rgba(40,28,22,.85)';
    [[98, 112], [158, 112]].forEach(([ex, ey]) => { x.beginPath(); x.ellipse(ex, ey, 8, 5.5, 0, 0, 7); x.fill(); });
    x.strokeStyle = 'rgba(60,40,30,.55)'; x.lineWidth = 4; x.lineCap = 'round';
    [[84, 98, 110, 94], [146, 94, 172, 98]].forEach(([a, b, cc, d]) => { x.beginPath(); x.moveTo(a, b); x.lineTo(cc, d); x.stroke(); });
    x.fillStyle = 'rgba(176,92,96,.85)'; x.beginPath(); x.ellipse(128, 176, 17, 5.5, 0, 0, 7); x.fill();
    x.fillStyle = 'rgba(120,70,50,.18)'; x.beginPath(); x.ellipse(128, 146, 6, 10, 0, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildBody(st, w) {
  const g = new THREE.Group();
  const skin = mat(st.skin, .55);

  const torso = new THREE.Mesh(new THREE.LatheGeometry([V2(0, .78), ...TORSO.map(([r, y]) => V2(r * (y < 1.4 ? w : 1), y)), V2(0, 1.52)], 64), skin);
  torso.scale.z = DEPTH; g.add(torso);

  for (const s of [-1, 1]) {
    const sh = new THREE.Mesh(new THREE.SphereGeometry(.052 * w, 24, 16), skin);
    sh.position.set(s * .16 * w, 1.345, 0); sh.scale.z = .9; g.add(sh);
    const [a, b] = armPoints(s, w);
    g.add(between(new THREE.CapsuleGeometry(.037 * Math.sqrt(w), a.distanceTo(b), 8, 20), a, b, skin));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(.034, 20, 14), skin);
    hand.position.set(s * .24 * w, .83, .025); hand.scale.set(.8, 1.4, .6); g.add(hand);
    const leg = new THREE.Mesh(new THREE.LatheGeometry([V2(0, .035), ...LEG.map(([r, y]) => V2(r * Math.sqrt(w), y)), V2(0, .845)], 40), skin);
    leg.position.x = s * .082 * w; g.add(leg);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skin);
    foot.position.set(s * .085 * w, .03, .045); foot.scale.set(.042, .032, .095); g.add(foot);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), skin);
    ear.position.set(s * HEAD.x * .98, HEAD.y, 0); ear.scale.set(.014, .028, .02); g.add(ear);
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), skin);
  head.position.y = HEAD.y; head.scale.set(HEAD.x, HEAD.yr, HEAD.z); g.add(head);

  const face = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32, Math.PI / 2 - .95, 1.9, .75, 1.85),
    new THREE.MeshStandardMaterial({ map: faceTexture(st), transparent: true, roughness: .6, polygonOffset: true, polygonOffsetFactor: -2 })
  );
  face.position.y = HEAD.y; face.scale.set(HEAD.x * 1.006, HEAD.yr * 1.006, HEAD.z * 1.006); g.add(face);

  g.add(buildHair(st));
  return g;
}

function buildHair(st) {
  const g = new THREE.Group();
  const hm = mat(st.hair, .72, { side: THREE.DoubleSide });
  const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, 1.05), hm);
  cap.position.y = 1.605; cap.scale.set(.098, .128, .108); g.add(cap);
  const prof = {
    bob: [[.1, 1.47], [.108, 1.5], [.112, 1.56], [.108, 1.62], [.096, 1.665]],
    long: [[.1, 1.18], [.128, 1.25], [.13, 1.38], [.118, 1.5], [.112, 1.58], [.104, 1.635], [.094, 1.67]],
    bun: [[.1, 1.555], [.106, 1.6], [.096, 1.665]]
  }[st.hairStyle] || null;
  if (prof) {
    const open = st.hairStyle === 'long' ? 1.0 : .85;
    const sides = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, y]) => V2(r, y)), 64, open, Math.PI * 2 - open * 2), hm);
    sides.scale.z = 1.04; g.add(sides);
  }
  if (st.hairStyle === 'bun') {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(.056, 24, 16), hm);
    bun.position.set(0, 1.68, -.1); g.add(bun);
  }
  return g;
}

/* ---------- clothes ---------- */
function wrap(y0, y1, off, w, steps = 18) {
  const pts = [];
  for (let i = 0; i <= steps; i++) { const y = y0 + (y1 - y0) * i / steps; pts.push(V2(torsoR(y, w) + off, y)); }
  return new THREE.LatheGeometry(pts, 72);
}
function depthGroup(...objs) { const g = new THREE.Group(); g.scale.z = DEPTH; objs.forEach(o => g.add(o)); return g; }

function buildTop(key, color, w) {
  const g = new THREE.Group(), m = mat(color, .88, { side: THREE.DoubleSide });
  const [y0, y1, off] = { t1: [.95, 1.33, .012], t2: [.95, 1.43, .012], t3: [1.05, 1.42, .018] }[key] || [.95, 1.4, .012];
  g.add(depthGroup(new THREE.Mesh(wrap(y0, y1, off, w), m)));
  for (const s of [-1, 1]) {
    const [a, b] = armPoints(s, w, key === 't1' ? .03 : 0);
    b.y += .035;
    g.add(between(new THREE.CapsuleGeometry(.037 * Math.sqrt(w) + .01, a.distanceTo(b), 8, 20), a, b, m));
    if (key !== 't1') {
      const sh = new THREE.Mesh(new THREE.SphereGeometry(.052 * w + .011, 24, 16), m);
      sh.position.set(s * .16 * w, 1.345, 0); sh.scale.z = .9; g.add(sh);
    }
  }
  if (key === 't1') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(torsoR(1.33, w) + .012, .012, 10, 72), m);
    band.rotation.x = Math.PI / 2; band.position.y = 1.33;
    g.add(depthGroup(band));
  }
  if (key === 't2') {
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(.056, .06, .085, 32, 1, true), m);
    neck.position.y = 1.47; g.add(neck);
  }
  if (key === 't3') {
    const bm = mat('#e9e2d4', .4);
    [1.1, 1.18, 1.26, 1.34].forEach(y => {
      const b = new THREE.Mesh(new THREE.SphereGeometry(.009, 12, 8), bm);
      b.position.set(0, y, (torsoR(y, w) + .018) * DEPTH + .004); g.add(b);
    });
  }
  return g;
}

function buildSkirt(key, color, w) {
  const [y0, y1, rb, n, amp, rough] = { k1: [1.045, .74, .23, 18, .05, .9], k2: [1.045, .77, .195, 0, 0, .95], k3: [1.045, .73, .205, 48, .014, 1] }[key] || [1.045, .75, .21, 0, 0, .9];
  const rt = torsoR(y0, w) + .02, h = y0 - y1;
  const geo = new THREE.CylinderGeometry(rt, rb * w, h, 144, 10, true);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = (h / 2 - y) / h, a = Math.atan2(x, z);
    const f = n ? 1 + amp * (.25 + t) * Math.sin(n * a) : 1;
    x *= f; z *= f * (DEPTH + (.86 - DEPTH) * t);
    p.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  const g = new THREE.Group();
  const sk = new THREE.Mesh(geo, mat(color, rough, { side: THREE.DoubleSide }));
  sk.position.y = (y0 + y1) / 2; g.add(sk);
  if (key === 'k2') {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(rt + .003, rt + .002, .028, 72, 1, true), mat(new THREE.Color(color).multiplyScalar(.8), .9, { side: THREE.DoubleSide }));
    band.position.y = y0 - .014; g.add(depthGroup(band));
    const btn = new THREE.Mesh(new THREE.SphereGeometry(.008, 10, 8), mat('#c8a765', .35, { metalness: .6 }));
    btn.position.set(0, y0 - .014, (rt + .004) * DEPTH); g.add(btn);
  }
  return g;
}

function buildShoes(key, color, w) {
  const g = new THREE.Group(), boots = key !== 's2';
  const m = mat(color, boots ? .42 : .6, { side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const x = s * .082 * w;
    const foot = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), m);
    foot.position.set(s * .085 * w, boots ? .036 : .042, .045);
    foot.scale.set(boots ? .047 : .053, boots ? .038 : .045, boots ? .105 : .112); g.add(foot);
    if (boots) {
      const pts = [];
      for (let y = .03; y <= .5; y += .02) pts.push(V2(legR(y, w) + .009, y));
      const shaft = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), m);
      shaft.position.x = x; g.add(shaft);
      const heel = new THREE.Mesh(new THREE.BoxGeometry(.028, .05, .03), m);
      heel.position.set(s * .085 * w, .025, -.03); g.add(heel);
    } else {
      const sole = new THREE.Mesh(new THREE.BoxGeometry(.1, .018, .225), mat('#e4e0d8', .7));
      sole.position.set(s * .085 * w, .009, .045); g.add(sole);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(.043, .046, .06, 24, 1, true), m);
      collar.position.set(x, .08, 0); g.add(collar);
    }
  }
  return g;
}

function buildBag(key, color, w) {
  const g = new THREE.Group(), m = mat(color, .5), gold = mat('#c8a765', .35, { metalness: .6 });
  const strap = (pts, r, material) => g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r, 6), material));
  if (key === 'g3') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(.2, .15, .08), m);
    body.position.set(.25 * w, .72, .03); g.add(body);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(.048, .008, 8, 28, Math.PI), m);
    handle.position.set(.25 * w, .795, .03); g.add(handle);
  } else {
    const mini = key === 'g2';
    const bw = mini ? .16 : .2, bh = mini ? .11 : .14, bd = mini ? .055 : .065, by = mini ? .98 : .92;
    const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    body.position.set(.32 * w, by, .03); g.add(body);
    if (mini) {
      const lm = mat(new THREE.Color(color).multiplyScalar(.85), .6);
      for (let i = -1; i <= 1; i++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(.003, bh * .9, .003), lm);
        l.position.set(.32 * w + i * .045, by, .03 + bd / 2); l.rotation.z = .5; g.add(l);
      }
    } else {
      const buckle = new THREE.Mesh(new THREE.BoxGeometry(.03, .03, .01), gold);
      buckle.position.set(.32 * w, by - .01, .03 + bd / 2 + .004); g.add(buckle);
    }
    strap([V3(.09 * w, 1.395, .05), V3(.16 * w, 1.405, 0), V3(.27 * w, 1.2, .06), V3(.32 * w, by + bh / 2, .03)], mini ? .004 : .006, mini ? gold : m);
  }
  return g;
}

const BUILD = { t: buildTop, k: buildSkirt, s: buildShoes, g: buildBag };

/* ---------- scene ---------- */
export async function createAvatar(el, st0) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, .1, 50);
  camera.position.set(0, .9, 4.9); camera.lookAt(0, .9, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc6ba, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(1.6, 3, 2.6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff4ea, .55); fill.position.set(-2.2, 1.2, 1.4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, .5); rim.position.set(0, 2, -3); scene.add(rim);

  const root = new THREE.Group(); scene.add(root);
  const parts = {}, sig = {};
  const pops = [];
  let st = null;

  function swap(name, obj, animate) {
    if (parts[name]) { root.remove(parts[name]); disposeTree(parts[name]); }
    parts[name] = obj; root.add(obj);
    if (animate) pops.push({ obj, t0: performance.now() });
  }

  function update(next) {
    const first = !st;
    st = next;
    const w = SIZE_W[st.size] || 1;
    const colors = { ...FALLBACK, ...(st.colors || {}) };
    root.scale.setScalar(Math.max(.9, Math.min(1.06, (st.height || 165) / 168)));
    const bodySig = [st.skin, st.hair, st.hairStyle, w, st.faceKey].join('|');
    if (sig.body !== bodySig) { sig.body = bodySig; swap('body', buildBody(st, w), !first); }
    for (const c of ['t', 'k', 's', 'g']) {
      const k = st.look[c], s = [k, colors[k], w].join('|');
      if (sig[c] !== s) { sig[c] = s; swap(c, BUILD[c](k, colors[k], w), !first); }
    }
  }

  // drag to turn, with a gentle spin when idle
  let rotY = -.35, vel = 0, drag = null, idleAt = performance.now();
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX }; vel = 0; el.setPointerCapture(e.pointerId); el.classList.add('dragging'); });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x; drag.x = e.clientX;
    rotY += dx * .012; vel = dx * .012;
  });
  const end = () => { drag = null; idleAt = performance.now(); el.classList.remove('dragging'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the whole figure in view on wide or narrow boxes
    camera.fov = w / h > .62 ? 24 : 24 * .62 / (w / h) * .98;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(el);

  let raf = 0, active = false;
  const back = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
  function frame(now) {
    if (!drag) {
      rotY += vel; vel *= .94;
      if (Math.abs(vel) < .0005 && now - idleAt > 2500) rotY += .0045;
    }
    root.rotation.y = rotY;
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i], t = Math.min(1, (now - p.t0) / 420);
      p.obj.scale.setScalar(.94 + .06 * back(t));
      if (t >= 1) { p.obj.scale.setScalar(1); pops.splice(i, 1); }
    }
    renderer.render(scene, camera);
    if (active) raf = requestAnimationFrame(frame);
  }
  function setActive(on) {
    if (on === active) return;
    active = on;
    if (on) { resize(); raf = requestAnimationFrame(frame); } else cancelAnimationFrame(raf);
  }

  update(st0);
  resize();
  return {
    update,
    setActive,
    dispose() { setActive(false); ro.disconnect(); disposeTree(root); renderer.dispose(); renderer.domElement.remove(); }
  };
}
