/* Maison Edit — identity preservation for the AI try-on.
 *
 * Runs entirely in the browser (nothing extra is uploaded):
 *   1. analysePerson()  checks the shopper's photo: exactly one person, face clearly visible, full body in frame.
 *   2. checkAndRestore() checks the AI result against that photo:
 *        - face identity (face-recognition descriptor distance), skin tone and hair
 *        - body proportions (shoulders, hips, torso, legs) and pose
 *        - clothing colours against the product photos
 *      If the face drifted, the shopper's real face is composited back onto the result
 *      (similarity-aligned with the face mesh, feathered mask, lighting matched on brightness only
 *      so the original skin tone is kept), and the result is checked again.
 *      A result that still does not match is returned with verdict 'fail' — never silently accepted.
 *
 * Uses Human (https://github.com/vladmandic/human) for BlazeFace + FaceMesh + MoveNet, and face-api
 * (https://github.com/vladmandic/face-api) for the identity descriptor (dlib ResNet, 128-d). Both share one TF.js engine.
 */

const HUMAN_VERSION = '3.3.6';
const FACEAPI_VERSION = '1.7.15';
const BASE = (globalThis.MAISON_VISION_BASE || `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/`).replace(/\/?$/, '/');
const FA_BASE = (globalThis.MAISON_FACEAPI_BASE || `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACEAPI_VERSION}/`).replace(/\/?$/, '/');

/* Thresholds. Identity is the Euclidean distance between face descriptors (lower = more alike).
 * Measured on labelled photos: same person in different photos ≤ 0.48, different people ≥ 0.65. */
export const LIMITS = {
  idKeep: 0.38,       // AI face this close or closer: keep it; further: restore the real face
  idPass: 0.45,       // final distance at or below: pass
  idMin: 0.55,        // final distance above: identity not preserved → fail
  idAmbiguous: 0.55,  // AI face between this and idStranger: restore only if hair, body and pose are clearly the shopper's
  idStranger: 0.66,   // AI face further than this: the AI drew a different person → reject, never patch
  skinPass: 9,        // ΔE (CIE76) between original and result skin; above → restore the face
  skinFail: 16,
  hairPass: 15,       // ΔE of the hair colour/area around the head
  hairFail: 28,
  neckWarn: 14,       // ΔE between the restored face and the AI's neck skin
  bodyPass: 0.09,     // largest relative change in a body proportion
  bodyFail: 0.18,
  posePass: 0.10,     // mean keypoint offset after alignment, as a share of torso length
  poseFail: 0.25,
  clothPass: 22,      // ΔE between product colour and the worn piece
  clothFail: 38,
  yawMax: 0.45,       // radians (~26°) of head turn difference we can still composite across
  pitchMax: 0.4,
  alignMax: 0.085     // mesh residual after alignment (share of face width): above, expression/shape differs too much to paste
};

/* MediaPipe face-mesh indices */
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const SKIN_PTS = [50, 280, 205, 425, 151, 9];      // cheeks, lower cheeks, forehead
const ALIGN_PTS = [33, 133, 362, 263, 1, 4, 61, 291, 199, 168, 6, 197, 195, 5, 70, 300, 105, 334, 152, 10, 234, 454, 58, 288];
const KP = ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];

let humanP = null;
function getHuman() {
  if (humanP) return humanP;
  humanP = (async () => {
    const { Human } = await import(BASE + 'dist/human.esm.js');
    const cfg = {
      modelBasePath: BASE + 'models/',
      backend: 'webgl',
      wasmPath: `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/`,
      cacheSensitivity: 0,        // still photos: never reuse a previous result
      skipAllowed: false,
      debug: false,
      filter: { enabled: true, equalization: false, flip: false },
      face: {
        enabled: true,
        detector: { enabled: true, rotation: true, maxDetected: 4, minConfidence: 0.35, iouThreshold: 0.2, return: false },
        mesh: { enabled: true },
        attention: { enabled: false },
        iris: { enabled: false },
        description: { enabled: false }, // identity comes from face-api (more accurate)
        emotion: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false }
      },
      body: { enabled: true, modelPath: 'movenet-lightning.json', maxDetected: 1, minConfidence: 0.2 },
      hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false }
    };
    let h = new Human(cfg);
    try { await h.load(); await h.warmup(); }
    catch (e) {
      // no WebGL (some Android WebViews): fall back to WebAssembly
      h = new Human({ ...cfg, backend: 'wasm' });
      await h.load(); await h.warmup();
    }
    const fa = await import(FA_BASE + 'dist/face-api.esm.js');
    await Promise.all([fa.nets.tinyFaceDetector, fa.nets.faceLandmark68Net, fa.nets.faceRecognitionNet].map(n => n.loadFromUri(FA_BASE + 'model')));
    h.faceapi = fa;
    return h;
  })();
  humanP.catch(() => { humanP = null; }); // allow a later retry (e.g. came back online)
  return humanP;
}
export const preload = () => getHuman().then(() => true, () => false);

/* ---------- small helpers ---------- */
export function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => rej(new Error('Image could not be opened'));
    i.src = src;
  });
}
function toCanvas(img, maxSide = 0) {
  const k = maxSide ? Math.min(1, maxSide / Math.max(img.width, img.height)) : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
  return c;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

function srgbToLab(r, g, b) {
  const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const t = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  x = t(x); y = t(y); z = t(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* median Lab colour of pixels in small discs around points */
function sampleLab(canvas, pts, r) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const L = [], A = [], B = [];
  r = Math.max(2, Math.round(r));
  for (const p of pts) {
    const x0 = Math.round(p[0] - r), y0 = Math.round(p[1] - r);
    if (x0 < 0 || y0 < 0 || x0 + 2 * r >= canvas.width || y0 + 2 * r >= canvas.height) continue;
    const d = ctx.getImageData(x0, y0, 2 * r, 2 * r).data;
    for (let y = 0; y < 2 * r; y++) for (let x = 0; x < 2 * r; x++) {
      if ((x - r) ** 2 + (y - r) ** 2 > r * r) continue;
      const i = (y * 2 * r + x) * 4, lab = srgbToLab(d[i], d[i + 1], d[i + 2]);
      L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
    }
  }
  return L.length ? [median(L), median(A), median(B)] : null;
}

/* ---------- detection ---------- */
function keypoints(body, w, h) {
  const k = {};
  if (!body) return k;
  // Use the normalised position: Human's MoveNet smooths jitter across calls (made for video) and can hand back
  // a keypoint object cached from the previous image, whose pixel position is in that image's size.
  for (const p of body.keypoints || []) if (p.score >= 0.3 && KP.includes(p.part)) {
    k[p.part] = p.positionRaw ? [p.positionRaw[0] * w, p.positionRaw[1] * h] : p.position.slice(0, 2);
  }
  return k;
}

/* 128-d identity descriptor of the largest face in a (head-cropped) canvas */
async function describe(fa, canvas) {
  for (const inputSize of [416, 608, 320]) {
    const all = await fa.detectAllFaces(canvas, new fa.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 })).withFaceLandmarks().withFaceDescriptors();
    const best = all.sort((a, b) => b.detection.box.area - a.detection.box.area)[0];
    if (best) return Array.from(best.descriptor);
  }
  return null;
}
const descDistance = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
const likeness = d => d <= 0.35 ? 'strong match' : d <= LIMITS.idPass ? 'match' : d <= LIMITS.idMin ? 'weak match' : 'very different';

/* Full-body photos make faces small, so after a first pass we crop the head and run the face models again at full size. */
async function detect(canvas) {
  const h = await getHuman();
  // note: Human merges per-call config into its settings, so state body on/off on every call
  const full = await h.detect(canvas, { body: { enabled: true } });
  const body = (full.body || []).sort((a, b) => b.score - a.score)[0];
  const kp = keypoints(body, canvas.width, canvas.height);
  const facesFull = (full.face || []).filter(f => f.faceScore >= 0.5 || f.score >= 0.5);

  // where is the head?
  let cx, cy, side;
  const big = facesFull.slice().sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
  if (kp.nose && (kp.leftShoulder && kp.rightShoulder)) {
    const sw = dist(kp.leftShoulder, kp.rightShoulder);
    const ears = kp.leftEar && kp.rightEar ? dist(kp.leftEar, kp.rightEar) : sw * 0.45;
    side = Math.max(ears * 3.2, sw * 1.05, big ? Math.max(big.box[2], big.box[3]) * 2.2 : 0);
    [cx, cy] = kp.nose; cy -= side * 0.06;
  } else if (big) {
    side = Math.max(big.box[2], big.box[3]) * 2.2;
    cx = big.box[0] + big.box[2] / 2; cy = big.box[1] + big.box[3] / 2;
  }

  let face = null;
  if (side) {
    const S = 512, crop = document.createElement('canvas'); crop.width = crop.height = S;
    const cctx = crop.getContext('2d');
    cctx.fillStyle = '#808080'; cctx.fillRect(0, 0, S, S);
    const x0 = cx - side / 2, y0 = cy - side / 2;
    cctx.drawImage(canvas, x0, y0, side, side, 0, 0, S, S);
    const r = await h.detect(crop, { body: { enabled: false } });
    const f = (r.face || []).filter(f => f.mesh && f.mesh.length >= 468).sort((a, b) => b.score - a.score)[0];
    if (f) {
      const k = side / S, map = p => [x0 + p[0] * k, y0 + p[1] * k];
      face = {
        score: f.faceScore ?? f.score,
        box: [x0 + f.box[0] * k, y0 + f.box[1] * k, f.box[2] * k, f.box[3] * k],
        mesh: f.mesh.slice(0, 468).map(map),
        embedding: await describe(h.faceapi, crop),
        angle: (f.rotation && f.rotation.angle) || { roll: 0, yaw: 0, pitch: 0 }
      };
    }
  }
  if (!face && big && big.mesh && big.mesh.length >= 468) {
    face = { score: big.faceScore ?? big.score, box: big.box, mesh: big.mesh.slice(0, 468).map(p => p.slice(0, 2)), embedding: await describe(h.faceapi, canvas), angle: (big.rotation && big.rotation.angle) || { roll: 0, yaw: 0, pitch: 0 } };
  }
  if (face) {
    const fw = dist(face.mesh[234], face.mesh[454]);
    face.width = fw;
    face.skin = sampleLab(canvas, SKIN_PTS.map(i => face.mesh[i]), fw * 0.05);
    // hair (above the forehead and at the temples) and neck skin (below the chin)
    const top = face.mesh[10], chin = face.mesh[152], fh = dist(top, chin) || 1;
    const up = [(top[0] - chin[0]) / fh, (top[1] - chin[1]) / fh], side = [-up[1], up[0]];
    const at = (o, u, v) => [o[0] + up[0] * u * fh + side[0] * v * fw, o[1] + up[1] * u * fh + side[1] * v * fw];
    face.hair = sampleLab(canvas, [at(top, 0.14, 0), at(top, 0.1, -0.28), at(top, 0.1, 0.28), at(top, 0.2, -0.12), at(top, 0.2, 0.12)], fw * 0.05);
    face.neck = sampleLab(canvas, [at(chin, -0.28, 0), at(chin, -0.22, -0.12), at(chin, -0.22, 0.12)], fw * 0.04);
  }
  // other people: any confident face whose centre is clearly away from the shopper's face
  const others = facesFull.filter(f => {
    if (!face) return true;
    const fc = [f.box[0] + f.box[2] / 2, f.box[1] + f.box[3] / 2], mc = [face.box[0] + face.box[2] / 2, face.box[1] + face.box[3] / 2];
    return dist(fc, mc) > Math.max(face.box[2], face.box[3]) * 0.6 && f.box[2] > face.box[2] * 0.35;
  }).length - (face ? 0 : 1);
  return { w: canvas.width, h: canvas.height, face, kp, bodyScore: body ? body.score : 0, others: Math.max(0, others), facesSeen: facesFull.length };
}

/* ---------- body proportions ---------- */
function proportions(kp) {
  const r = {};
  if (kp.leftShoulder && kp.rightShoulder && kp.leftHip && kp.rightHip) {
    const sw = dist(kp.leftShoulder, kp.rightShoulder), hw = dist(kp.leftHip, kp.rightHip);
    const torso = dist(mid(kp.leftShoulder, kp.rightShoulder), mid(kp.leftHip, kp.rightHip));
    if (torso > 1) {
      r.shoulders = sw / torso;
      r.hips = hw / torso;
      const legs = [['leftHip', 'leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee', 'rightAnkle']]
        .filter(l => l.every(p => kp[p])).map(l => (dist(kp[l[0]], kp[l[1]]) + dist(kp[l[1]], kp[l[2]])) / torso);
      if (legs.length) r.legs = legs.reduce((a, b) => a + b) / legs.length;
      if (kp.nose) r.neck = dist(kp.nose, mid(kp.leftShoulder, kp.rightShoulder)) / torso;
    }
  }
  return r;
}
/* mean keypoint offset after similarity alignment, as a share of the pose's size (RMS spread of the matched points) */
function poseDiff(a, b) {
  const parts = KP.filter(p => a[p] && b[p]);
  if (parts.length < 6) return null;
  const B = parts.map(p => b[p]);
  const T = similarity(parts.map(p => a[p]), B);
  const c = B.reduce((s, q) => [s[0] + q[0] / B.length, s[1] + q[1] / B.length], [0, 0]);
  const spread = Math.sqrt(B.reduce((s, q) => s + (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2, 0) / B.length);
  if (!spread) return null;
  return parts.reduce((s, p) => s + dist(apply(T, a[p]), b[p]), 0) / parts.length / spread;
}

/* ---------- geometry: 2-D similarity transform (Umeyama), src → dst ---------- */
function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let a = 0, b = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - mx, py = src[i][1] - my, qx = dst[i][0] - nx, qy = dst[i][1] - ny;
    a += px * qx + py * qy; b += px * qy - py * qx; v += px * px + py * py;
  }
  const c = a / v, s = b / v;
  return { c, s, tx: nx - (c * mx - s * my), ty: ny - (s * mx + c * my) };
}
const apply = (T, p) => [T.c * p[0] - T.s * p[1] + T.tx, T.s * p[0] + T.c * p[1] + T.ty];

/* ---------- face compositing ---------- */
function boxBlur(alpha, w, h, r) {
  const tmp = new Float32Array(alpha.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) { // horizontal
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += alpha[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += alpha[row + Math.min(w - 1, x + r + 1)] - alpha[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) { // vertical
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        alpha[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
}

/** Paste the shopper's real face (from their photo) onto the generated image. Returns a canvas, or null with a reason. */
export function compositeFace(origCanvas, orig, genCanvas, gen) {
  const of = orig.face, gf = gen.face;
  if (!of || !gf) return { canvas: null, reason: 'no-face' };
  if (Math.abs(of.angle.yaw - gf.angle.yaw) > LIMITS.yawMax || Math.abs(of.angle.pitch - gf.angle.pitch) > LIMITS.pitchMax)
    return { canvas: null, reason: 'head-turned' };

  const T = similarity(ALIGN_PTS.map(i => of.mesh[i]), ALIGN_PTS.map(i => gf.mesh[i]));
  const resid = ALIGN_PTS.reduce((s, i) => s + dist(apply(T, of.mesh[i]), gf.mesh[i]), 0) / ALIGN_PTS.length / gf.width;
  if (resid > LIMITS.alignMax) return { canvas: null, reason: 'expression' };

  const W = genCanvas.width, H = genCanvas.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(genCanvas, 0, 0);

  // the original photo, moved/rotated/scaled so its face lands on the generated face (shape untouched)
  const warp = document.createElement('canvas'); warp.width = W; warp.height = H;
  const wctx = warp.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.setTransform(T.c, T.s, -T.s, T.c, T.tx, T.ty);
  wctx.drawImage(origCanvas, 0, 0);
  wctx.setTransform(1, 0, 0, 1, 0, 0);

  // mask: the face oval (original's, warped), pulled slightly inwards, feathered
  const oval = OVAL.map(i => apply(T, of.mesh[i]));
  const c0 = oval.reduce((a, p) => [a[0] + p[0] / oval.length, a[1] + p[1] / oval.length], [0, 0]);
  const shrink = 0.95;
  const poly = oval.map(p => [c0[0] + (p[0] - c0[0]) * shrink, c0[1] + (p[1] - c0[1]) * shrink]);
  const fw = gf.width, pad = Math.ceil(fw * 0.12);
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const bx = Math.max(0, Math.floor(Math.min(...xs) - pad)), by = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const bw = Math.min(W, Math.ceil(Math.max(...xs) + pad)) - bx, bh = Math.min(H, Math.ceil(Math.max(...ys) + pad)) - by;
  if (bw < 8 || bh < 8) return { canvas: null, reason: 'too-small' };

  const mc = document.createElement('canvas'); mc.width = bw; mc.height = bh;
  const mctx = mc.getContext('2d', { willReadFrequently: true });
  mctx.fillStyle = '#fff'; mctx.beginPath();
  poly.forEach((p, i) => (i ? mctx.lineTo : mctx.moveTo).call(mctx, p[0] - bx, p[1] - by));
  mctx.closePath(); mctx.fill();
  const md = mctx.getImageData(0, 0, bw, bh).data, alpha = new Float32Array(bw * bh);
  for (let i = 0; i < alpha.length; i++) alpha[i] = md[i * 4] / 255;
  boxBlur(alpha, bw, bh, Math.max(1, Math.round(fw * 0.035)));

  const src = wctx.getImageData(bx, by, bw, bh), dst = octx.getImageData(bx, by, bw, bh);
  const s = src.data, d = dst.data;

  // lighting: match brightness (L) halfway to the scene, keep the original colour (a, b) = original skin tone
  let sl = 0, dl = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 0.9) {
    const j = i * 4;
    sl += 0.2126 * s[j] + 0.7152 * s[j + 1] + 0.0722 * s[j + 2];
    dl += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]; n++;
  }
  const gain = n ? Math.min(1.25, Math.max(0.8, 1 + ((dl / n) / Math.max(1, sl / n) - 1) * 0.5)) : 1;

  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]; if (a <= 0.002) continue;
    const j = i * 4;
    for (let ch = 0; ch < 3; ch++) d[j + ch] = Math.round(d[j + ch] * (1 - a) + Math.min(255, s[j + ch] * gain) * a);
  }
  octx.putImageData(dst, bx, by);
  return { canvas: out, reason: null, residual: resid };
}

/* ---------- clothing colour ---------- */
function productColour(canvas) {
  // the dominant non-background colour of a product photo (background = border colour)
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas, d = ctx.getImageData(0, 0, w, h).data;
  const border = [];
  for (let x = 0; x < w; x += 4) { border.push(x * 4, ((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y += 4) { border.push((y * w) * 4, (y * w + w - 1) * 4); }
  const bg = [0, 1, 2].map(c => median(border.map(i => d[i + c])));
  const bgLab = srgbToLab(...bg);
  const L = [], A = [], B = [];
  for (let y = Math.floor(h * .08); y < h * .92; y += 2) for (let x = Math.floor(w * .08); x < w * .92; x += 2) {
    const i = (y * w + x) * 4, lab = srgbToLab(d[i], d[i + 1], d[i + 2]);
    if (deltaE(lab, bgLab) < 7) continue;
    L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
  }
  return L.length > 50 ? [median(L), median(A), median(B)] : null;
}
function wornColour(canvas, kp, cat) {
  const S = kp.leftShoulder, R = kp.rightShoulder, LH = kp.leftHip, RH = kp.rightHip;
  if (!S || !R || !LH || !RH) return null;
  const pts = [];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const torso = dist(mid(S, R), mid(LH, RH));
  if (cat === 't') {
    for (const t of [0.3, 0.5, 0.7]) for (const u of [0.3, 0.5, 0.7]) pts.push(lerp(lerp(S, R, u), lerp(LH, RH, u), t));
  } else if (cat === 'k') {
    const LK = kp.leftKnee, RK = kp.rightKnee, base = mid(LH, RH);
    const down = LK && RK ? mid(LK, RK) : [base[0], base[1] + torso * 0.6];
    for (const t of [0.15, 0.35, 0.55]) for (const u of [0.3, 0.5, 0.7]) pts.push(lerp(lerp(LH, RH, u), lerp(LH, RH, u).map((v, k) => v + (down[k] - base[k])), t));
  } else if (cat === 's') {
    for (const a of ['leftAnkle', 'rightAnkle']) if (kp[a]) pts.push([kp[a][0], kp[a][1] + torso * 0.04]);
  } else return null;
  return pts.length ? sampleLab(canvas, pts, torso * (cat === 's' ? 0.03 : 0.05)) : null;
}

/* ---------- public API ---------- */

/** Check the shopper's photo before generating. */
export async function analysePerson(src) {
  const canvas = toCanvas(typeof src === 'string' ? await loadImage(src) : src, 1600);
  const a = await detect(canvas);
  const issues = [];
  if (!a.face) issues.push({ level: 'block', text: 'No face found. Use a photo where your face is clearly visible, facing the camera.' });
  if (a.others > 0) issues.push({ level: 'block', text: 'More than one person is in the photo. Use a photo of just you.' });
  if (a.face && a.face.width < 48) issues.push({ level: 'warn', text: 'Your face is small in this photo, so the likeness check is less certain. A sharper or closer photo works better.' });
  if (a.face && Math.abs(a.face.angle.yaw) > 0.6) issues.push({ level: 'warn', text: 'Your head is turned away. Facing the camera gives the most accurate result.' });
  if (a.face && !a.face.embedding) issues.push({ level: 'block', text: 'Your face could not be read clearly. Try a sharper, well-lit photo.' });
  const fullBody = ['nose', 'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'].every(p => a.kp[p]) && (a.kp.leftAnkle || a.kp.rightAnkle);
  if (a.face && !fullBody) issues.push({ level: 'warn', text: 'Your whole body is not in the frame. Head to feet works best for skirts and shoes.' });
  return { ok: !issues.some(i => i.level === 'block'), issues, analysis: a, canvas };
}

/** A tight, high-resolution crop of the face to send to the image model as an extra identity reference. */
export function faceCrop(canvas, analysis, size = 512) {
  const f = analysis && analysis.face; if (!f) return null;
  const xs = f.mesh.map(p => p[0]), ys = f.mesh.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.7; // include hair and jaw
  const c = document.createElement('canvas'); c.width = c.height = Math.min(size, Math.max(128, Math.round(side * 2)));
  const x = c.getContext('2d'); x.fillStyle = '#808080'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(canvas, cx - side / 2, cy - side / 2 - side * 0.06, side, side, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

async function score(h, orig, gen) {
  const idDist = orig.face && gen.face && orig.face.embedding && gen.face.embedding ? descDistance(orig.face.embedding, gen.face.embedding) : null;
  const skin = orig.face && gen.face && orig.face.skin && gen.face.skin ? deltaE(orig.face.skin, gen.face.skin) : null;
  return { idDist, skin };
}

/**
 * Check a generated image against the shopper's photo; restore the face if it drifted.
 * @param person   result of analysePerson()
 * @param genSrc   data URL of the AI image
 * @param products [{ c: 't'|'k'|'s'|'g', name, image: dataURL }]
 * @returns { image, raw, restored, verdict: 'pass'|'warn'|'fail', checks: [...], summary }
 */
export async function checkAndRestore(person, genSrc, products = []) {
  const h = await getHuman();
  const orig = person.analysis, origCanvas = person.canvas;
  let genCanvas = toCanvas(await loadImage(genSrc), 1600);
  let gen = await detect(genCanvas);
  const checks = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });

  // ----- the context around the face: hair, body proportions, pose (not touched by a face restore) -----
  const hairDE = orig.face && gen.face && orig.face.hair && gen.face.hair ? deltaE(orig.face.hair, gen.face.hair) : null;
  const po = proportions(orig.kp), pg = proportions(gen.kp);
  const bodyKeys = Object.keys(po).filter(k => k in pg);
  const bodyDiffs = bodyKeys.map(k => Math.abs(pg[k] - po[k]) / po[k]);
  const bodyWorst = bodyKeys.length >= 2 ? Math.max(...bodyDiffs) : null;
  const pd = poseDiff(orig.kp, gen.kp);
  // Is this still the shopper's own head and body, with only the face redrawn?
  const ownBody = hairDE != null && hairDE <= LIMITS.hairPass && (bodyWorst == null || bodyWorst <= LIMITS.bodyPass) && (pd == null || pd <= LIMITS.posePass);

  // ----- face -----
  let { idDist, skin } = await score(h, orig, gen);
  let restored = false, image = genSrc, restoreNote = null;
  const before = { idDist, skin };
  // A far-off face on someone else's head/body = the AI drew a different person: reject it, don't patch a stranger.
  // A far-off face on the shopper's own hair, body and pose = the AI redrew the face: restore it.
  const substitutedPerson = idDist != null && (idDist > LIMITS.idStranger || (idDist > LIMITS.idAmbiguous && !ownBody));
  const needsRestore = gen.face && !substitutedPerson && (idDist == null || idDist > LIMITS.idKeep || (skin != null && skin > LIMITS.skinPass));
  if (needsRestore) {
    const r = compositeFace(origCanvas, orig, genCanvas, gen);
    if (r.canvas) {
      const g2 = await detect(r.canvas);
      const s2 = await score(h, orig, g2);
      if (g2.face && s2.idDist != null && (idDist == null || s2.idDist <= idDist)) {
        genCanvas = r.canvas; gen = { ...g2, kp: Object.keys(g2.kp).length ? g2.kp : gen.kp };
        ({ idDist, skin } = s2); restored = true;
        image = r.canvas.toDataURL('image/jpeg', 0.93);
      }
    } else restoreNote = { 'head-turned': 'the head is turned differently from your photo', expression: 'the face angle or expression is too different from your photo', 'too-small': 'the face is too small', 'no-face': 'no face was found' }[r.reason];
  }

  if (!gen.face) add('face', 'Your face', 'fail', 'No face could be found in the result.');
  else if (substitutedPerson)
    add('face', 'Your face', 'fail', 'The AI replaced you with a different person. Your face is not pasted onto someone else, so this result is rejected.');
  else if (idDist == null) add('face', 'Your face', 'fail', 'The face in the result could not be compared with your photo.');
  else {
    const st = idDist <= LIMITS.idPass ? 'pass' : idDist <= LIMITS.idMin ? 'warn' : 'fail';
    const why = before.idDist == null ? 'the AI face could not be read'
      : before.idDist > LIMITS.idKeep ? `the AI changed your face (${likeness(before.idDist)})`
      : 'the AI changed your skin tone';
    const how = restored ? `Restored from your photo because ${why}. ` : '';
    add('face', 'Your face', st, `${how}Likeness to your photo: ${likeness(idDist)}.${!restored && restoreNote && st !== 'pass' ? ` Could not restore it: ${restoreNote}.` : ''}`);
  }
  if (skin != null) add('skin', 'Skin tone', skin <= LIMITS.skinPass ? 'pass' : skin <= LIMITS.skinFail ? 'warn' : 'fail',
    skin <= LIMITS.skinPass ? 'Same as your photo.' : `Differs from your photo (ΔE ${skin.toFixed(1)}).`);

  if (hairDE != null) {
    // a weak AI likeness was only accepted because the head around it is theirs: then the hair must match
    const strictHair = restored && (before.idDist ?? 1) > LIMITS.idMin;
    const st = hairDE <= LIMITS.hairPass ? 'pass' : hairDE <= LIMITS.hairFail && !strictHair ? 'warn' : 'fail';
    add('hair', 'Hair', st, st === 'pass' ? 'Hairstyle and colour match your photo.' : 'Your hair looks different from your photo.');
  }
  if (!substitutedPerson && gen.face && gen.face.skin && gen.face.neck && orig.face && orig.face.neck && deltaE(orig.face.skin || orig.face.neck, orig.face.neck) < LIMITS.neckWarn) {
    // only meaningful if the neck was visible skin in the original too
    const d = deltaE(gen.face.skin, gen.face.neck);
    if (d > LIMITS.neckWarn) add('neck', 'Neck and skin', 'warn', 'The neck skin does not quite match your face. It may show a seam.');
  }

  // ----- body -----
  if (bodyWorst != null) {
    const wk = bodyKeys[bodyDiffs.indexOf(bodyWorst)];
    const names = { shoulders: 'shoulder width', hips: 'hip width', legs: 'leg length', neck: 'neck and head height' };
    add('body', 'Body shape', bodyWorst <= LIMITS.bodyPass ? 'pass' : bodyWorst <= LIMITS.bodyFail ? 'warn' : 'fail',
      bodyWorst <= LIMITS.bodyPass ? 'Proportions match your photo.' : `${names[wk][0].toUpperCase() + names[wk].slice(1)} changed by about ${Math.round(bodyWorst * 100)}%.`);
  } else add('body', 'Body shape', Object.keys(po).length >= 2 ? 'warn' : 'skip',
    Object.keys(po).length >= 2 ? 'Could not measure body proportions in the result.' : 'Not checked: your photo does not show enough of your body.');
  if (pd != null) add('pose', 'Pose', pd <= LIMITS.posePass ? 'pass' : pd <= LIMITS.poseFail ? 'warn' : 'fail', pd <= LIMITS.posePass ? 'Same pose as your photo.' : 'The pose differs from your photo.');

  // ----- clothing -----
  for (const p of products) {
    if (!['t', 'k', 's'].includes(p.c) || !p.image) continue;
    try {
      const want = productColour(toCanvas(await loadImage(p.image), 400));
      const got = wornColour(genCanvas, gen.kp, p.c);
      if (!want || !got) continue;
      const d = deltaE(want, got);
      add('cloth-' + p.c, p.name, d <= LIMITS.clothPass ? 'pass' : d <= LIMITS.clothFail ? 'warn' : 'fail',
        d <= LIMITS.clothPass ? 'Colour matches the product.' : 'Colour looks different from the product photo.');
    } catch { /* product photo unavailable: skip */ }
  }

  // identity and body are strict; pose and clothing colour are advisory (lighting changes colour)
  const strict = checks.filter(c => ['face', 'skin', 'hair', 'body'].includes(c.key));
  const verdict = strict.some(c => c.status === 'fail') ? 'fail'
    : checks.some(c => c.status === 'warn' || c.status === 'fail') ? 'warn' : 'pass';
  const summary = verdict === 'pass' ? (restored ? 'Verified: this is you. Your face was restored from your photo.' : 'Verified: this is you.')
    : verdict === 'warn' ? 'Mostly matches your photo. Check the notes below, or regenerate.'
    : 'This does not look enough like you. Regenerate to try again.';
  return { image, raw: genSrc, restored, verdict, checks, summary, scores: { idDist, skin, hair: hairDE, body: bodyWorst, pose: pd, before } };
}
