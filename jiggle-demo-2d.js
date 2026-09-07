"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — 2D demo (Canvas renderer).
 * Mirrors the 3D page: cycle geometries, each with a preset of edge bones;
 * the outline follows them (point += Σ_b w_b * offset_b). A floor plane and a
 * draggable ring are colliders. World units: 1 = 100 px, y up, origin centre.
 * ========================================================================== */

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const PX = 100;
const LOOP_N = 96;
// Region mass from painted outline fraction: a lobe of ~20% of the outline is size 1.
const AREA_REF = 0.2, SIZE_MIN = 0.5, SIZE_MAX = 2.0;
const BONE_RGB = [[240, 160, 112], [127, 176, 224], [143, 208, 143]];
const BONE_CSS = BONE_RGB.map((c) => "rgb(" + c.join(",") + ")");
const REST_RGB = [70, 68, 72];
const PLAIN_CSS = "rgba(232,226,212,0.55)";

// ---- geometries: loops of rest points + lobe presets (angle, amp, sigma per bone)
const circle = (r) => (t) => [r * Math.cos(t * Math.PI * 2), r * Math.sin(t * Math.PI * 2)];
function capsule(r, hh) {
  const L = 2 * hh, C = Math.PI * r, P = 2 * L + 2 * C;
  return (t) => {
    let s = t * P;
    if (s < L) return [r, -hh + s];
    s -= L; if (s < C) { const a = s / r; return [r * Math.cos(a), hh + r * Math.sin(a)]; }
    s -= C; if (s < L) return [-r, hh - s];
    s -= L; const a = Math.PI + s / r; return [r * Math.cos(a), -hh + r * Math.sin(a)];
  };
}
const GEOS = [
  { name: "Disc",    loops: [circle(0.7)],               lobes: [[-Math.PI / 2, 1.0, 0.9], [0, 0.8, 0.4], [Math.PI, 0.8, 0.4]] },
  { name: "Capsule", loops: [capsule(0.42, 0.42)],       lobes: [[-Math.PI / 2, 1.0, 0.7], [0, 0.6, 0.45], [Math.PI, 0.6, 0.45]] },
  { name: "Ring",    loops: [circle(0.75), circle(0.42)], lobes: [[-Math.PI / 2, 1.0, 0.55], [Math.PI / 6, 1.0, 0.55], [5 * Math.PI / 6, 1.0, 0.55]] }
];
// Bake each geometry once: rest points, per-point weights, tint, bone rest
// points, and each bone's region size (painted fraction of the outline).
for (const g of GEOS) {
  const n = g.loops.length * LOOP_N;
  g.rest = new Float32Array(n * 2);
  g.w = new Float32Array(n * 3);
  g.tint = new Array(n);
  g.boneRest = [[0, 0], [0, 0], [0, 0]];
  g.size = [1, 1, 1];
  const best = [Infinity, Infinity, Infinity], sum = [0, 0, 0];
  for (let l = 0; l < g.loops.length; l++) {
    for (let k = 0; k < LOOP_N; k++) {
      const i = l * LOOP_N + k;
      const p = g.loops[l](k / LOOP_N);
      g.rest[i * 2] = p[0]; g.rest[i * 2 + 1] = p[1];
      const th = Math.atan2(p[1], p[0]);
      const rgb = REST_RGB.slice();
      for (let b = 0; b < 3; b++) {
        let d = th - g.lobes[b][0];
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const s = g.lobes[b][2];
        const w = g.lobes[b][1] * Math.exp(-d * d / (2 * s * s));
        g.w[i * 3 + b] = w;
        sum[b] += w;
        for (let c = 0; c < 3; c++) rgb[c] += w * (BONE_RGB[b][c] - REST_RGB[c]);
        if (l === 0 && Math.abs(d) < best[b]) { best[b] = Math.abs(d); g.boneRest[b] = p; }
      }
      g.tint[i] = "rgb(" + rgb.map((c) => Math.round(Math.min(255, c))).join(",") + ")";
    }
  }
  for (let b = 0; b < 3; b++) g.size[b] = Math.min(SIZE_MAX, Math.max(SIZE_MIN, sum[b] / n / AREA_REF));
}
const pts = new Float32Array(2 * LOOP_N * 2);

// ---- simulation ----------------------------------------------------------
const physics = createJigglePhysics({ bones: 3, seed: 7 });
const P = physics.params;
const driver = createJiggleDriver({ tau: 0.012 });
const colliders = createJiggleColliders({ limit: 0.6 });
const floor = colliders.plane(0, 1, 0, -2);
const ring = colliders.sphere(1.8, -0.4, 0, 0.5);
const body = [-0.8, 0.5, 0];
const drive = [0, 0, 0];
let driveGain = 1.0;
let geo = 0, showBones = true;

// ---- DOM -----------------------------------------------------------------
const elGeoName = document.getElementById("geoName");
const bGeo = document.getElementById("bGeo");
const bShow = document.getElementById("bShow");
const hint = document.getElementById("hint");
let hintArmed = true;
function consumedHint() { if (hintArmed) { hintArmed = false; hint.classList.add("gone"); } }

function setGeo(g) {
  geo = g;
  elGeoName.textContent = GEOS[geo].name;
  bGeo.textContent = "geometry: " + GEOS[geo].name.toLowerCase();
  for (let b = 0; b < 3; b++) physics.bones[b].size = GEOS[geo].size[b];
  physics.reset();
  consumedHint();
}
function setShow(on) {
  showBones = on; bShow.classList.toggle("on", on);
  bShow.textContent = on ? "hide bones" : "show bones";
}
function shake() { physics.shake(); consumedHint(); }
function reseed() { physics.reseed(); consumedHint(); }
function reset() {
  body[0] = -0.8; body[1] = 0.5;
  ring.cx = 1.8; ring.cy = -0.4;
  driver.reset(drive); physics.reset();
  consumedHint();
}
bGeo.addEventListener("click", () => setGeo((geo + 1) % GEOS.length));
bShow.addEventListener("click", () => setShow(!showBones));
document.getElementById("bShake").addEventListener("click", shake);
document.getElementById("bSeed").addEventListener("click", reseed);
document.getElementById("bReset").addEventListener("click", reset);

function bindSlider(id, set, digits) {
  const el = document.getElementById(id), out = document.getElementById(id + "V");
  const sync = () => { set(parseFloat(el.value)); out.textContent = parseFloat(el.value).toFixed(digits); };
  el.addEventListener("input", () => { sync(); consumedHint(); });
  sync();
}
bindSlider("kFreq", (v) => P.freq = v, 2);
bindSlider("kDamp", (v) => P.damp = v, 2);
bindSlider("kGrav", (v) => P.g = v, 1);
bindSlider("oDrive", (v) => driveGain = v, 2);

window.addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") setGeo((geo + 1) % GEOS.length);
  else if (e.key === "w" || e.key === "W") setShow(!showBones);
  else if (e.key === " ") shake();
  else if (e.key === "x" || e.key === "X") reseed();
  else if (e.key === "r" || e.key === "R") reset();
  else return;
  e.preventDefault();
});

// ---- pointer: drag the body or the ring collider --------------------------
const toWorld = (px, py) => [(px - canvas.width / 2) / PX, -(py - canvas.height / 2) / PX];
const sx = (x) => canvas.width / 2 + x * PX;
const sy = (y) => canvas.height / 2 - y * PX;
let drag = null, grabX = 0, grabY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const w = toWorld(e.clientX, e.clientY);
  const onRing = Math.hypot(w[0] - ring.cx, w[1] - ring.cy) < ring.r + 0.15;
  drag = onRing ? ring : body;
  grabX = w[0] - (onRing ? ring.cx : body[0]); grabY = w[1] - (onRing ? ring.cy : body[1]);
  document.body.classList.add("dragging");
  consumedHint();
  e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const w = toWorld(e.clientX, e.clientY);
  if (drag === ring) { ring.cx = w[0] - grabX; ring.cy = w[1] - grabY; }
  else { body[0] = w[0] - grabX; body[1] = w[1] - grabY; }
});
function endDrag() { drag = null; document.body.classList.remove("dragging"); }
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function resize() {
  const w = innerWidth, h = innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    floor.d = -(h / 2 - 90) / PX;
  }
}
window.addEventListener("resize", resize);
resize();
setGeo(0); setShow(true);

// ---- loop ----------------------------------------------------------------
function simulate(dt) {
  drive[0] = body[0] * driveGain; drive[1] = body[1] * driveGain;
  physics.update(dt, driver.update(dt, drive));
  const g = GEOS[geo];
  for (let b = 0; b < 3; b++) {
    const J = physics.bones[b];
    colliders.resolve(J.x, J.v, body[0] + g.boneRest[b][0], body[1] + g.boneRest[b][1], 0);
  }
  physics.pack();
}

function draw() {
  const W = canvas.width, H = canvas.height;
  const g = GEOS[geo], off = physics.offsets;
  ctx.fillStyle = "#050507"; ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(232,226,212,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, sy(floor.d)); ctx.lineTo(W, sy(floor.d)); ctx.stroke();
  ctx.beginPath(); ctx.arc(sx(ring.cx), sy(ring.cy), ring.r * PX, 0, Math.PI * 2); ctx.stroke();

  ctx.beginPath();
  for (let l = 0; l < g.loops.length; l++) {
    for (let k = 0; k < LOOP_N; k++) {
      const i = l * LOOP_N + k;
      let x = body[0] + g.rest[i * 2], y = body[1] + g.rest[i * 2 + 1];
      for (let b = 0; b < 3; b++) { x += g.w[i * 3 + b] * off[b * 3]; y += g.w[i * 3 + b] * off[b * 3 + 1]; }
      pts[i * 2] = sx(x); pts[i * 2 + 1] = sy(y);
      if (k === 0) ctx.moveTo(pts[i * 2], pts[i * 2 + 1]); else ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
    }
    ctx.closePath();
  }
  ctx.fillStyle = "rgba(230,165,150,0.16)"; ctx.fill("evenodd");
  ctx.lineWidth = 3;
  for (let l = 0; l < g.loops.length; l++) {
    for (let k = 0; k < LOOP_N; k++) {
      const i = l * LOOP_N + k, j = l * LOOP_N + (k + 1) % LOOP_N;
      ctx.strokeStyle = showBones ? g.tint[i] : PLAIN_CSS;
      ctx.beginPath(); ctx.moveTo(pts[i * 2], pts[i * 2 + 1]); ctx.lineTo(pts[j * 2], pts[j * 2 + 1]); ctx.stroke();
    }
  }
  if (!showBones) return;

  ctx.lineWidth = 1.5;
  for (let b = 0; b < 3; b++) {
    const rx = sx(body[0] + g.boneRest[b][0]), ry = sy(body[1] + g.boneRest[b][1]);
    const bx = rx + off[b * 3] * PX, by = ry - off[b * 3 + 1] * PX;
    ctx.strokeStyle = BONE_CSS[b]; ctx.fillStyle = BONE_CSS[b];
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(bx, by); ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  simulate(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
