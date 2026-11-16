/* Maison Edit — 3D avatar.
 * A figure built in the browser (no AI, no upload): smooth anatomical body shaped by
 * height and size, a sculpted head with the shopper's face (or a painted default),
 * strand-textured hair, and fitted clothes with fabric textures in the products' colours.
 * Lit with a studio environment, soft shadows and filmic tone mapping.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SIZE_G = { XS: .9, S: .95, M: 1, L: 1.07, XL: 1.15 };
const FALLBACK = {
  t1: '#ece6dc', t2: '#1d1d1f', t3: '#6e1c2a',
  k1: '#3b3b3e', k2: '#86a0c4', k3: '#e6dccb',
  s1: '#161616', s2: '#f1f0ec', s3: '#5a1622',
  g1: '#1a1a1a', g2: '#d9cfc0', g3: '#6b1a26'
};
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* ================= geometry helpers ================= */
// A "ring" is an elliptical cross-section: y height, w half-width, d back depth, f front depth,
// x/z centre offset, p shape (1 = ellipse, <1 = squarer).
const ringDefaults = r => ({ x: 0, z: 0, p: 1, f: r.d, ...r });
const cr = (a, b, c, d, t) => .5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
function smooth(ctrl, steps) {
  const R = ctrl.map(ringDefaults), keys = ['y', 'w', 'd', 'f', 'x', 'z', 'p'], out = [];
  for (let i = 0; i < R.length - 1; i++) {
    const a = R[Math.max(0, i - 1)], b = R[i], c = R[i + 1], d = R[Math.min(R.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, r = {};
      for (const k of keys) r[k] = cr(a[k], b[k], c[k], d[k], t);
      out.push(r);
    }
  }
  out.push({ ...R[R.length - 1] });
  return out;
}
/** Smooth surface through elliptical rings. `mod(x, z, angle, ring, t)` may reshape each point. */
function loft(ctrl, { seg = 64, steps = 5, mod = null } = {}) {
  const rings = smooth(ctrl, steps), n = rings.length;
  const pos = [], uv = [], idx = [];
  rings.forEach((r, i) => {
    for (let j = 0; j <= seg; j++) {
      const a = Math.PI + j / seg * Math.PI * 2; // seam at the back
      const s = Math.sin(a), c = Math.cos(a);
      let x = Math.sign(s) * Math.pow(Math.abs(s), r.p) * Math.max(r.w, 0);
      let z = Math.sign(c) * Math.pow(Math.abs(c), r.p) * Math.max(c >= 0 ? r.f : r.d, 0);
      if (mod) [x, z] = mod(x, z, a, r, i / (n - 1));
      pos.push(r.x + x, r.y, r.z + z);
      uv.push(j / seg, i / (n - 1));
    }
  });
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point outwards (check the front of the middle ring)
  const nr = g.attributes.normal, mid = Math.floor(n / 2) * (seg + 1) + seg / 2;
  if (nr.getZ(mid) < 0) { idx.reverse(); g.setIndex(idx); g.computeVertexNormals(); }
  // weld the seam so it does not show
  for (let i = 0; i < n; i++) {
    const a = i * (seg + 1), b = a + seg;
    const v = V3(nr.getX(a) + nr.getX(b), nr.getY(a) + nr.getY(b), nr.getZ(a) + nr.getZ(b)).normalize();
    nr.setXYZ(a, v.x, v.y, v.z); nr.setXYZ(b, v.x, v.y, v.z);
  }
  return g;
}
/** Builds a limb loft along local +y (0 → length) and places it from `a` (bottom) to `b` (top). */
function limb(ctrlFn, a, b, material, opts) {
  const L = a.distanceTo(b);
  const m = new THREE.Mesh(loft(ctrlFn(L), opts), material);
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(V3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}
function interpRings(rings, y) {
  // linear lookup of a smoothed ring list at height y
  if (y <= rings[0].y) return rings[0];
  for (let i = 1; i < rings.length; i++) {
    const a = rings[i - 1], b = rings[i];
    if (y <= b.y) { const t = (y - a.y) / (b.y - a.y || 1); const r = {}; for (const k in a) r[k] = a[k] + (b[k] - a[k]) * t; return r; }
  }
  return rings[rings.length - 1];
}
function shadowy(o) { o.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); return o; }
function disposeTree(o) {
  o.traverse(n => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) [].concat(n.material).forEach(m => { ['map', 'bumpMap', 'roughnessMap'].forEach(k => m[k] && m[k].dispose()); m.dispose(); });
  });
}

/* ================= canvas textures ================= */
const texCache = {};
function canvasTex(key, w, h, paint, repeat = [1, 1], color = false) {
  if (!texCache[key]) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    texCache[key] = c;
  }
  const t = new THREE.CanvasTexture(texCache[key]);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = 4;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
const KNIT = rep => canvasTex('knit', 256, 256, (x, w, h) => {
  for (let i = 0; i < w; i++) { const v = 128 + 90 * Math.sin(i / w * Math.PI * 2 * 24); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, 0, 1, h); }
  for (let y = 0; y < h; y += 4) { x.fillStyle = 'rgba(0,0,0,.08)'; x.fillRect(0, y, w, 1); }
}, rep);
const TWILL = rep => canvasTex('twill', 256, 256, (x, w, h) => {
  x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 2;
  for (let i = -h; i < w; i += 6) { x.beginPath(); x.moveTo(i, h); x.lineTo(i + h, 0); x.stroke(); }
  for (let i = 0; i < 3000; i++) { x.fillStyle = `rgba(0,0,0,${rnd() * .15})`; x.fillRect(rnd() * w, rnd() * h, 2, 1); }
}, rep);
const TWEED = rep => canvasTex('tweed', 256, 256, (x, w, h) => {
  x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) { const v = Math.floor(rnd() * 255); x.fillStyle = `rgba(${v},${v},${v},.5)`; x.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 1 + rnd() * 2); }
}, rep);
const TWEED_COLOR = rep => canvasTex('tweedc', 256, 256, (x, w, h) => {
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 6000; i++) { const v = 200 + Math.floor(rnd() * 55); x.fillStyle = `rgb(${v},${v - 6},${v - 14})`; x.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 2); }
  for (let i = 0; i < 500; i++) { x.fillStyle = 'rgba(90,70,60,.35)'; x.fillRect(rnd() * w, rnd() * h, 2, 1); }
}, rep, true);
const QUILT = rep => canvasTex('quilt', 256, 256, (x, w, h) => {
  x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, w, h);
  x.strokeStyle = '#2a2a2a'; x.lineWidth = 5;
  for (let i = -h; i < w + h; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + h, h); x.stroke(); x.beginPath(); x.moveTo(i, h); x.lineTo(i + h, 0); x.stroke(); }
}, rep);
const GRAIN = rep => canvasTex('grain', 256, 256, (x, w, h) => {
  x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 7000; i++) { x.fillStyle = `rgba(${rnd() > .5 ? '255,255,255' : '0,0,0'},.12)`; x.beginPath(); x.arc(rnd() * w, rnd() * h, rnd() * 1.6, 0, 7); x.fill(); }
}, rep);
const SKINPORE = rep => canvasTex('pore', 256, 256, (x, w, h) => {
  x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 5000; i++) { x.fillStyle = `rgba(0,0,0,${rnd() * .12})`; x.fillRect(rnd() * w, rnd() * h, 1, 1); }
}, rep);

/* ================= materials ================= */
function fabric(color, kind) {
  const c = new THREE.Color(color);
  const base = { color: c, side: THREE.DoubleSide, envMapIntensity: .55 };
  switch (kind) {
    case 'knit': return new THREE.MeshPhysicalMaterial({ ...base, roughness: .92, sheen: .6, sheenRoughness: .7, sheenColor: c.clone().lerp(new THREE.Color('#fff'), .35), bumpMap: KNIT([10, 6]), bumpScale: 1.4 });
    case 'denim': return new THREE.MeshPhysicalMaterial({ ...base, roughness: .95, sheen: .3, sheenColor: new THREE.Color('#dfe8f5'), bumpMap: TWILL([8, 6]), bumpScale: 1.2 });
    case 'tweed': return new THREE.MeshPhysicalMaterial({ ...base, color: c, map: TWEED_COLOR([6, 4]), roughness: 1, sheen: .5, sheenRoughness: .9, sheenColor: new THREE.Color('#fff'), bumpMap: TWEED([6, 4]), bumpScale: 2 });
    case 'wool': return new THREE.MeshPhysicalMaterial({ ...base, roughness: .9, sheen: .45, sheenRoughness: .8, sheenColor: c.clone().lerp(new THREE.Color('#fff'), .3), bumpMap: GRAIN([8, 6]), bumpScale: .6 });
    case 'leather': return new THREE.MeshPhysicalMaterial({ ...base, roughness: .38, clearcoat: .55, clearcoatRoughness: .35, bumpMap: GRAIN([4, 4]), bumpScale: .5, envMapIntensity: .9 });
    case 'quilt': return new THREE.MeshPhysicalMaterial({ ...base, roughness: .5, clearcoat: .3, bumpMap: QUILT([2, 2]), bumpScale: 3, envMapIntensity: .8 });
    default: return new THREE.MeshPhysicalMaterial({ ...base, roughness: .85 });
  }
}
function skinMat(color, map) {
  return new THREE.MeshPhysicalMaterial({
    color: map ? 0xffffff : new THREE.Color(color), map: map || null,
    roughness: .52, sheen: .35, sheenRoughness: .55, sheenColor: new THREE.Color('#ffd0c0'),
    bumpMap: SKINPORE([6, 6]), bumpScale: .25, envMapIntensity: .5
  });
}
const gold = () => new THREE.MeshPhysicalMaterial({ color: '#c9a86a', metalness: .9, roughness: .3, envMapIntensity: 1.2 });

/* ================= body ================= */
// Torso outline (female, 1.70 m): hips, waist, bust, shoulders, neck.
const TORSO = [
  { y: .765, w: .04, d: .035 },
  { y: .80, w: .135, d: .085, f: .07, p: .95 },
  { y: .87, w: .168, d: .105, f: .084, p: .9 },
  { y: .95, w: .158, d: .092, f: .08, p: .9 },
  { y: 1.03, w: .122, d: .072, f: .068, p: .92 },
  { y: 1.10, w: .128, d: .07, f: .075, p: .92 },
  { y: 1.18, w: .14, d: .074, f: .1, p: .9 },
  { y: 1.245, w: .146, d: .077, f: .1, p: .9 },
  { y: 1.30, w: .148, d: .074, f: .078, p: .85 },
  { y: 1.355, w: .14, d: .064, f: .062, p: .72 },
  { y: 1.392, w: .112, d: .056, f: .054, p: .8 },
  { y: 1.42, w: .062, d: .05, f: .046 },
  { y: 1.45, w: .05, d: .047, f: .043 },
  { y: 1.50, w: .047, d: .045, f: .041 },
  { y: 1.535, w: .04, d: .04, f: .036 }
];
const torsoCtrl = g => TORSO.map(r => r.y < 1.41 ? { ...r, w: r.w * g, d: r.d * g, f: (r.f ?? r.d) * g } : r);

// Head: evenly spaced rings so the face texture maps linearly in height.
const HEAD_Y = 1.6, HEAD_H = .122;
const HEAD = [
  [-.122, .012, .02, .02], [-.0976, .042, .05, .062], [-.0732, .06, .07, .074], [-.0488, .071, .08, .08],
  [-.0244, .077, .088, .084], [0, .08, .094, .087], [.0244, .08, .097, .087], [.0488, .079, .098, .083],
  [.0732, .072, .092, .074], [.0976, .055, .072, .054], [.122, .012, .014, .012]
].map(([y, w, d, f]) => ({ y, w, d, f }));
const headRings = smooth(HEAD, 1);

// canvas coordinates of a point on the face (metres from head centre)
const FX = (X, Y) => 256 + Math.asin(Math.max(-1, Math.min(1, X / (interpRings(headRings, Y).w + .004)))) / (Math.PI * 2) * 512;
const FY = Y => 512 * (1 - (Y + HEAD_H) / (HEAD_H * 2));
function headTexture(st) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = st.skin; x.fillRect(0, 0, 512, 512);
  if (st.face) {
    // the shopper's photo, already feathered into an oval
    const l = FX(-.063, -.01), r = FX(.063, -.01), t = FY(.066), b = FY(-.114);
    x.drawImage(st.face, l, t, r - l, b - t);
  } else {
    const sk = new THREE.Color(st.skin);
    const shade = (k, a) => `rgba(${Math.round(sk.r * 255 * k)},${Math.round(sk.g * 255 * k)},${Math.round(sk.b * 255 * k)},${a})`;
    const ell = (X, Y, rx, ry, fill) => { x.fillStyle = fill; x.beginPath(); x.ellipse(FX(X, Y), FY(Y), rx * 1018, ry * 2098, 0, 0, 7); x.fill(); };
    // soft modelling: cheeks, eye sockets, nose shadow
    [-1, 1].forEach(s => {
      const g = x.createRadialGradient(FX(s * .04, -.035), FY(-.035), 2, FX(s * .04, -.035), FY(-.035), 40);
      g.addColorStop(0, 'rgba(225,120,110,.22)'); g.addColorStop(1, 'rgba(225,120,110,0)');
      x.fillStyle = g; x.fillRect(0, 0, 512, 512);
      ell(s * .031, .01, .016, .009, shade(.82, .35));
    });
    ell(.0035, -.03, .006, .012, shade(.78, .35));
    ell(0, -.037, .009, .004, shade(.72, .4));
    [-1, 1].forEach(s => {
      const ex = s * .031, ey = .012;
      ell(ex, ey, .0115, .0048, '#f6f1ec');
      ell(ex, ey, .0055, .0048, '#4a3326');
      ell(ex, ey, .0027, .0026, '#120c0a');
      ell(ex + .0018, ey + .0015, .0012, .0009, 'rgba(255,255,255,.9)');
      x.strokeStyle = '#1b1210'; x.lineWidth = 3.5; x.lineCap = 'round';
      x.beginPath(); x.moveTo(FX(ex - s * .012, ey), FY(ey + .0005));
      x.quadraticCurveTo(FX(ex, ey + .007), FY(ey + .007), FX(ex + s * .013, ey + .002), FY(ey + .002)); x.stroke();
      x.strokeStyle = 'rgba(55,38,30,.85)'; x.lineWidth = 5;
      x.beginPath(); x.moveTo(FX(ex - s * .013, ey + .016), FY(ey + .016));
      x.quadraticCurveTo(FX(ex, ey + .024), FY(ey + .024), FX(ex + s * .015, ey + .019), FY(ey + .019)); x.stroke();
    });
    ell(0, -.06, .016, .0042, '#b8686c');
    ell(0, -.0652, .0135, .0045, '#c27277');
    x.strokeStyle = 'rgba(110,50,55,.6)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(FX(-.016, -.0615), FY(-.0615)); x.quadraticCurveTo(FX(0, -.063), FY(-.063), FX(.016, -.0615), FY(-.0615)); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const JOINTS = g => {
  const J = {};
  for (const s of [-1, 1]) {
    J[s] = {
      shoulder: V3(s * .148 * g, 1.362, -.006), elbow: V3(s * .192 * g, 1.085, -.018), wrist: V3(s * .21 * g, .842, .012),
      hip: V3(s * .086 * g, .86, 0), knee: V3(s * .07 * g, .476, .008), ankle: V3(s * .066 * g, .074, -.008)
    };
  }
  return J;
};
const UPPER_ARM = (L, o = 0) => [{ y: -.016, w: .012 + o, d: .012 + o }, { y: 0, w: .027 + o, d: .026 + o }, { y: .05, w: .03 + o, d: .029 + o }, { y: L * .45, w: .036 + o, d: .035 + o }, { y: L * .8, w: .043 + o, d: .04 + o }, { y: L, w: .04 + o, d: .038 + o }, { y: L + .022, w: .02 + o, d: .02 + o }];
const FOREARM = (L, o = 0) => [{ y: -.01, w: .012 + o, d: .01 + o }, { y: 0, w: .022 + o, d: .018 + o }, { y: .05, w: .024 + o, d: .02 + o }, { y: L * .62, w: .032 + o, d: .028 + o }, { y: L * .86, w: .031 + o, d: .028 + o }, { y: L, w: .028 + o, d: .027 + o }, { y: L + .014, w: .014 + o, d: .014 + o }];
const THIGH = (L, o = 0) => [{ y: -.02, w: .03 + o, d: .03 + o }, { y: 0, w: .045 + o, d: .045 + o, f: .047 + o }, { y: .06, w: .05 + o, d: .05 + o, f: .052 + o }, { y: .18, w: .065 + o, d: .065 + o, f: .068 + o }, { y: .3, w: .078 + o, d: .078 + o }, { y: L, w: .085 + o, d: .085 + o }, { y: L + .05, w: .06 + o, d: .06 + o }];
const SHIN = (L, o = 0) => [{ y: -.012, w: .018 + o, d: .018 + o }, { y: 0, w: .026 + o, d: .028 + o, f: .024 + o }, { y: .08, w: .031 + o, d: .034 + o, f: .027 + o }, { y: .2, w: .043 + o, d: .053 + o, f: .039 + o }, { y: .3, w: .045 + o, d: .05 + o, f: .041 + o }, { y: L, w: .044 + o, d: .045 + o, f: .046 + o }, { y: L + .022, w: .03 + o, d: .03 + o }];
// foot, built along +y then turned to point forward; f = sole side, d = instep side
const FOOT = (o = 0, sole = 0) => [{ y: -.006, w: .012 + o, d: .014 + o, f: .006 + sole }, { y: 0, w: .026 + o, d: .03 + o, f: .012 + sole }, { y: .05, w: .029 + o, d: .036 + o, f: .012 + sole }, { y: .13, w: .037 + o, d: .026 + o, f: .012 + sole }, { y: .19, w: .036 + o, d: .016 + o, f: .011 + sole }, { y: .225, w: .024 + o, d: .01 + o, f: .009 + sole }, { y: .238, w: .006 + o, d: .004 + o, f: .004 + sole }];
function placeFoot(s, J, ctrl, material) {
  const m = new THREE.Mesh(loft(ctrl, { seg: 40 }), material);
  m.rotation.x = Math.PI / 2; // local +y → forward (+z), local +z (sole) → down
  m.rotation.z = s * -.08;
  m.position.set(J[s].ankle.x, .022, J[s].ankle.z - .062);
  return m;
}
const HAND = L => [{ y: 0, w: .004, d: .006 }, { y: .02, w: .008, d: .016 }, { y: .065, w: .012, d: .025 }, { y: .11, w: .013, d: .027 }, { y: L, w: .012, d: .021 }, { y: L + .014, w: .01, d: .012 }];

function buildBody(st, g) {
  const grp = new THREE.Group(), J = JOINTS(g);
  const skin = skinMat(st.skin);
  grp.add(new THREE.Mesh(loft(torsoCtrl(g), { seg: 72, steps: 6 }), skin));
  for (const s of [-1, 1]) {
    const j = J[s];
    grp.add(limb(L => UPPER_ARM(L), j.elbow, j.shoulder, skin, { seg: 32 }));
    grp.add(limb(L => FOREARM(L), j.wrist, j.elbow, skin, { seg: 32 }));
    const fingertip = j.wrist.clone().add(V3(s * .012, -.165, .012));
    const hand = limb(L => HAND(L), fingertip, j.wrist, skin, { seg: 24 });
    hand.rotateY(s * .25); grp.add(hand);
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(.0085, .04, 6, 12), skin);
    thumb.position.copy(j.wrist).add(V3(-s * .004, -.045, .022)); thumb.rotation.set(.35, 0, s * .3); grp.add(thumb);
    grp.add(limb(L => THIGH(L), j.knee, j.hip, skin, { seg: 40 }));
    grp.add(limb(L => SHIN(L), j.ankle, j.knee, skin, { seg: 40 }));
    grp.add(placeFoot(s, J, FOOT(), skin));
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
    ear.position.set(s * .079, HEAD_Y + .002, -.004); ear.scale.set(.011, .026, .017); ear.rotation.y = s * .4; grp.add(ear);
  }
  const head = new THREE.Mesh(loft(HEAD, { seg: 96, steps: 1 }), skinMat(st.skin, headTexture(st)));
  head.position.y = HEAD_Y; grp.add(head);
  // a little nose so the face is not flat
  const nose = new THREE.Mesh(loft([{ y: 0, w: .001, d: .001 }, { y: .006, w: .009, d: .006, f: .011 }, { y: .02, w: .007, d: .004, f: .007 }, { y: .04, w: .005, d: .003, f: .003 }], { seg: 24, steps: 4 }), skinMat(st.skin));
  nose.position.set(0, HEAD_Y - .042, .079); grp.add(nose);
  shadowy(grp);
  // hair receives light and shadow but does not cast (its cut-out face window would shadow the face)
  const hair = buildHair(st);
  hair.traverse(n => { if (n.isMesh) n.receiveShadow = true; });
  grp.add(hair);
  return grp;
}

/* ================= hair ================= */
function hairTexture(st, style, yb) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const x = c.getContext('2d'), H = c.height, base = new THREE.Color(st.hair);
  x.fillStyle = st.hair; x.fillRect(0, 0, 512, H);
  for (let i = 0; i < 2600; i++) {
    const px = rnd() * 512, k = .55 + rnd() * .9;
    x.strokeStyle = `rgba(${Math.round(Math.min(255, base.r * 255 * k + 12))},${Math.round(Math.min(255, base.g * 255 * k + 10))},${Math.round(Math.min(255, base.b * 255 * k + 8))},.55)`;
    x.lineWidth = .6 + rnd() * 1.4;
    x.beginPath(); x.moveTo(px, 0); x.bezierCurveTo(px + (rnd() - .5) * 18, H * .3, px + (rnd() - .5) * 18, H * .6, px + (rnd() - .5) * 10, H); x.stroke();
  }
  // parting line
  x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(254, 0, 4, H * .03);
  // cut out the face (and the front of long hair), with a natural hairline
  const top = .134, span = top - yb;
  const Y = py => top - py / H * span;
  x.globalCompositeOperation = 'destination-out';
  for (let py = 0; py < H; py++) {
    const y = Y(py);
    let half;
    if (y > -.13) {
      // rounded hairline: highest at the centre, lower at the temples
      const hl = .07;
      if (y > hl) continue;
      half = y > hl - .03 ? .158 * Math.sqrt(1 - Math.pow((y - (hl - .03)) / .03, 2)) : .158;
    } else half = style === 'long' ? .2 : .5;
    x.fillStyle = '#000';
    x.fillRect(256 - half * 512, py, half * 1024, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function buildHair(st) {
  const g = new THREE.Group(), style = st.hairStyle || 'bob';
  const yb = style === 'long' ? -.46 : style === 'bob' ? -.115 : .0;
  const rings = [];
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const y = yb + (.134 - yb) * i / steps;
    if (y >= -.01) {
      // a dome a little larger than the skull, so the top is round with volume
      const h = interpRings(headRings, Math.min(HEAD_H, y / 1.1)), top = y > .118 ? Math.max(0, 1 - (y - .118) / .016) : 1;
      rings.push({ y, w: (h.w * 1.1 + .006) * top, d: (h.d * 1.1 + .006) * top, f: (h.f * 1.08 + .005) * top });
    } else if (y >= -.13) {
      // falls straight past the cheeks and jaw
      const k = (y + .13) / .12;
      rings.push({ y, w: .093 + .002 * k, d: .108, f: .095, z: -.004 * (1 - k) });
    } else {
      // long hair hangs behind the shoulders
      const k = Math.min(1, (-.13 - y) / .12);
      rings.push({ y, w: .093 + .012 * k, d: .108 - .03 * k, f: .095 - .095 * k + .03 * k, z: -.045 * k });
    }
  }
  const mat = new THREE.MeshPhysicalMaterial({
    map: hairTexture(st, style, yb), alphaTest: .5, side: THREE.DoubleSide,
    roughness: .48, sheen: .9, sheenRoughness: .35, sheenColor: new THREE.Color(st.hair).lerp(new THREE.Color('#ffffff'), .5), envMapIntensity: .6
  });
  const hair = new THREE.Mesh(loft(rings, { seg: 96, steps: 1 }), mat);
  hair.position.y = HEAD_Y; g.add(hair);
  if (style === 'bun') {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(.052, 32, 24), mat.clone());
    bun.material.alphaTest = 0; bun.position.set(0, HEAD_Y + .085, -.085); g.add(bun);
  }
  return g;
}

/* ================= clothes ================= */
function bodyRings(g) { return smooth(torsoCtrl(g), 6); }
function wrapTorso(g, ys, off) {
  const R = bodyRings(g);
  return ys.map(([y, extra = 0]) => { const r = interpRings(R, y); return { y, w: r.w + off + extra, d: r.d + off + extra, f: r.f + off + extra, p: r.p }; });
}
function buildTop(key, color, g) {
  const grp = new THREE.Group(), J = JOINTS(g);
  const m = fabric(color, key === 't2' ? 'knit' : key === 't3' ? 'knit' : 'wool');
  if (key === 't1') {
    // off-shoulder knit: bare shoulders, folded band across the arms
    grp.add(new THREE.Mesh(loft([...wrapTorso(g, [[.965, -.002], [1.0], [1.06], [1.13], [1.2], [1.26], [1.3]], .012), ...wrapTorso(g, [[1.318, .016]], .012), { y: 1.326, w: .17 * g, d: .085 * g, f: .1 * g, p: .8 }, { y: 1.31, w: .168 * g, d: .083 * g, f: .098 * g, p: .8 }], { seg: 72, steps: 4 }), m));
    for (const s of [-1, 1]) {
      const j = J[s];
      grp.add(limb(L => UPPER_ARM(L, .012).filter(r => r.y < L * .82).concat([{ y: L * .82, w: .046, d: .044 }]), j.elbow, j.shoulder, m, { seg: 32 }));
      grp.add(limb(L => [{ y: -.012, w: .028, d: .026 }, { y: 0, w: .033, d: .031 }, ...FOREARM(L, .014).slice(2)], j.wrist, j.elbow, m, { seg: 32 }));
    }
  } else {
    const t2 = key === 't2';
    const ys = t2 ? [[.96], [1.03], [1.1], [1.18], [1.245], [1.3], [1.355], [1.392], [1.42], [1.45], [1.48]] : [[1.06, .01], [1.1], [1.18], [1.245], [1.3], [1.355], [1.392], [1.42, .004]];
    const rings = wrapTorso(g, ys, t2 ? .009 : .014);
    if (t2) rings.push({ y: 1.5, w: .062, d: .058, f: .056 }, { y: 1.512, w: .06, d: .056, f: .054 }, { y: 1.5, w: .053, d: .051, f: .048 });
    else rings.unshift({ y: 1.05, w: rings[0].w - .006, d: rings[0].d - .006, f: rings[0].f - .006 });
    grp.add(new THREE.Mesh(loft(rings, { seg: 72, steps: 4 }), m));
    for (const s of [-1, 1]) {
      const j = J[s];
      grp.add(limb(L => UPPER_ARM(L, .011), j.elbow, j.shoulder, m, { seg: 32 }));
      grp.add(limb(L => [{ y: -.015, w: .022, d: .02 }, { y: -.004, w: .03, d: .028 }, ...FOREARM(L, .012).slice(1)], j.wrist, j.elbow, m, { seg: 32 }));
    }
    if (!t2) {
      // cardigan buttons and placket
      const R = bodyRings(g), bm = new THREE.MeshPhysicalMaterial({ color: '#efe7da', roughness: .3, clearcoat: .6 });
      [1.11, 1.18, 1.25, 1.32, 1.39].forEach(y => {
        const r = interpRings(R, y);
        const b = new THREE.Mesh(new THREE.CylinderGeometry(.0075, .0075, .004, 16), bm);
        b.rotation.x = Math.PI / 2; b.position.set(0, y, r.f + .017); grp.add(b);
      });
    }
  }
  return shadowy(grp);
}

function buildSkirt(key, color, g) {
  const R = bodyRings(g);
  const cfg = { k1: { hem: .74, hw: .225, hd: .17, n: 22, amp: .07, kind: 'wool' }, k2: { hem: .765, hw: .19, hd: .14, n: 0, amp: 0, kind: 'denim' }, k3: { hem: .73, hw: .205, hd: .155, n: 0, amp: 0, kind: 'tweed' } }[key] || { hem: .75, hw: .2, hd: .15, n: 0, amp: 0, kind: 'wool' };
  const at = y => interpRings(R, y);
  const w0 = at(1.045), hp = at(.87);
  const ctrl = [
    { y: cfg.hem - .004, w: cfg.hw * g - .006, d: cfg.hd * g - .006, f: (cfg.hd - .015) * g - .006 },
    { y: cfg.hem, w: cfg.hw * g, d: cfg.hd * g, f: (cfg.hd - .015) * g },
    { y: (cfg.hem + .87) / 2, w: (cfg.hw * g + hp.w + .018) / 2 + .01, d: (cfg.hd * g + hp.d + .02) / 2 + .006, f: ((cfg.hd - .015) * g + hp.f + .016) / 2 + .006 },
    { y: .87, w: hp.w + .018, d: hp.d + .02, f: hp.f + .016 },
    { y: .96, w: at(.96).w + .016, d: at(.96).d + .016, f: at(.96).f + .016 },
    { y: 1.045, w: w0.w + .016, d: w0.d + .016, f: w0.f + .016 },
    { y: 1.06, w: w0.w + .014, d: w0.d + .014, f: w0.f + .014 }
  ];
  const mod = cfg.n ? (x, z, a, r) => {
    const k = Math.max(0, Math.min(1, (.9 - r.y) / (.9 - cfg.hem)));
    const f = 1 + cfg.amp * k * Math.abs(Math.sin(cfg.n * a / 2)) - cfg.amp * k * .5;
    return [x * f, z * f];
  } : null;
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(loft(ctrl, { seg: cfg.n ? 176 : 96, steps: 6, mod }), fabric(color, cfg.kind)));
  if (key === 'k2') {
    const band = fabric(new THREE.Color(color).multiplyScalar(.82), 'denim');
    grp.add(new THREE.Mesh(loft([{ y: 1.022, w: w0.w + .019, d: w0.d + .019, f: w0.f + .019 }, { y: 1.05, w: w0.w + .019, d: w0.d + .019, f: w0.f + .019 }], { seg: 96, steps: 1 }), band));
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(.008, .008, .004, 16), gold());
    btn.rotation.x = Math.PI / 2; btn.position.set(0, 1.036, w0.f + .022); grp.add(btn);
  }
  return shadowy(grp);
}

function buildShoes(key, color, g) {
  const grp = new THREE.Group(), J = JOINTS(g), boots = key !== 's2';
  const m = fabric(color, 'leather');
  for (const s of [-1, 1]) {
    if (boots) {
      grp.add(limb(L => SHIN(L, .007).filter(r => r.y < L * .9).concat([{ y: L * .9, w: .05, d: .056, f: .052 }, { y: L * .9 + .004, w: .046, d: .052, f: .048 }]), J[s].ankle, J[s].knee, m, { seg: 40 }));
      grp.add(placeFoot(s, J, FOOT(.006, .004), m));
      const heel = new THREE.Mesh(new RoundedBoxGeometry(.034, .045, .036, 2, .006), m);
      heel.position.set(J[s].ankle.x, .022, J[s].ankle.z - .045); grp.add(heel);
    } else {
      grp.add(placeFoot(s, J, FOOT(.011, .006), m));
      const sole = placeFoot(s, J, FOOT(.014, .012).map(r => ({ ...r, d: Math.min(r.d, .012) })), new THREE.MeshPhysicalMaterial({ color: '#ebe7df', roughness: .7 }));
      sole.position.y -= .006; grp.add(sole);
      grp.add(limb(L => [{ y: 0, w: .036, d: .04, f: .034 }, { y: L, w: .034, d: .038, f: .032 }], J[s].ankle.clone().add(V3(0, -.02, 0)), J[s].ankle.clone().add(V3(0, .035, 0)), m, { seg: 32 }));
    }
  }
  return shadowy(grp);
}

function buildBag(key, color, g) {
  const grp = new THREE.Group(), J = JOINTS(g), w = J[1].wrist;
  const strap = (pts, r, mat) => grp.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, r, 8), mat));
  if (key === 'g3') {
    const m = fabric(color, 'leather');
    const body = new THREE.Mesh(new RoundedBoxGeometry(.22, .16, .085, 4, .018), m);
    body.position.set(w.x + .02, .62, w.z + .02); grp.add(body);
    const flap = new THREE.Mesh(new RoundedBoxGeometry(.222, .06, .088, 4, .012), m);
    flap.position.set(w.x + .02, .675, w.z + .021); grp.add(flap);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(.05, .007, 10, 32, Math.PI), m);
    handle.position.set(w.x + .02, .7, w.z + .02); grp.add(handle);
    const clasp = new THREE.Mesh(new RoundedBoxGeometry(.03, .02, .008, 2, .003), gold());
    clasp.position.set(w.x + .02, .655, w.z + .066); grp.add(clasp);
  } else {
    const mini = key === 'g2';
    const m = fabric(color, mini ? 'quilt' : 'leather');
    const bw = mini ? .17 : .23, bh = mini ? .115 : .15, bd = mini ? .055 : .07, x = .3 * g + bw * .15, y = mini ? .97 : .9;
    const body = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 4, .016), m);
    body.position.set(x, y, .03); body.rotation.z = -.06; grp.add(body);
    if (!mini) {
      const flap = new THREE.Mesh(new RoundedBoxGeometry(bw + .004, bh * .55, bd + .004, 4, .014), m);
      flap.position.set(x, y + bh * .22, .031); flap.rotation.z = -.06; grp.add(flap);
      const buckle = new THREE.Mesh(new THREE.TorusGeometry(.016, .004, 8, 4), gold());
      buckle.position.set(x, y + .005, .03 + bd / 2 + .004); buckle.rotation.z = Math.PI / 4; grp.add(buckle);
    }
    const sh = J[1].shoulder;
    strap([V3(-.02, 1.402, .06), V3(sh.x - .035, 1.418, .01), V3(sh.x + .02, 1.37, -.02), V3(sh.x + .07, 1.2, .0), V3(x + bw * .35, y + bh / 2, .03)], mini ? .004 : .007, mini ? gold() : m);
  }
  return shadowy(grp);
}

const BUILD = { t: buildTop, k: buildSkirt, s: buildShoes, g: buildBag };

/* ================= scene ================= */
export async function createAvatar(el, st0) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;

  const camera = new THREE.PerspectiveCamera(24, 1, .1, 50);
  camera.position.set(0, .95, 4.9); camera.lookAt(0, .9, 0);

  const key = new THREE.DirectionalLight(0xfff4ea, 2.1);
  key.position.set(1.4, 3.2, 2.4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .015; key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -.8, right: .8, top: 2, bottom: -.2, near: .5, far: 8 });
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe8f0ff, .45); fill.position.set(-2.4, 1.4, 1.6); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, .9); rim.position.set(-.6, 2.4, -3); scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: .22 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const root = new THREE.Group(); scene.add(root);
  const parts = {}, sig = {}, pops = [];
  let st = null;

  function swap(name, obj, animate) {
    if (parts[name]) { root.remove(parts[name]); disposeTree(parts[name]); }
    parts[name] = obj; root.add(obj);
    if (animate) pops.push({ obj, t0: performance.now() });
  }
  function update(next) {
    const first = !st;
    st = next;
    const g = SIZE_G[st.size] || 1;
    const colors = { ...FALLBACK, ...(st.colors || {}) };
    const s = Math.max(.9, Math.min(1.06, (st.height || 165) / 168));
    root.scale.setScalar(s);
    const bodySig = [st.skin, st.hair, st.hairStyle, g, st.faceKey].join('|');
    if (sig.body !== bodySig) { sig.body = bodySig; swap('body', buildBody(st, g), !first); }
    for (const c of ['t', 'k', 's', 'g']) {
      const k = st.look[c], sg = [k, colors[k], g].join('|');
      if (sig[c] !== sg) { sig[c] = sg; swap(c, BUILD[c](k, colors[k], g), !first); }
    }
  }

  // drag to turn, with a slow spin when idle
  let rotY = -.3, vel = 0, drag = null, idleAt = performance.now();
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX }; vel = 0; el.setPointerCapture(e.pointerId); el.classList.add('dragging'); });
  el.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x; drag.x = e.clientX; rotY += dx * .012; vel = dx * .012; });
  const end = () => { drag = null; idleAt = performance.now(); el.classList.remove('dragging'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h > .62 ? 24 : 24 * .62 / (w / h) * .98;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(el);

  let raf = 0, active = false, t0 = performance.now();
  const back = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
  function frame(now) {
    if (!drag) {
      rotY += vel; vel *= .94;
      if (Math.abs(vel) < .0005 && now - idleAt > 2500) rotY += .004;
    }
    root.rotation.y = rotY;
    // breathing
    const b = Math.sin((now - t0) / 1000 * 1.6) * .004;
    if (parts.body) parts.body.scale.set(1 + b * .3, 1 + b * .15, 1 + b);
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i], t = Math.min(1, (now - p.t0) / 420);
      p.obj.scale.setScalar(.95 + .05 * back(t));
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
    update, setActive,
    dispose() { setActive(false); ro.disconnect(); disposeTree(root); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove(); }
  };
}
