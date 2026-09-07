"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — 1D demo.
 * One axis, three bones with identical frequency and ζ = 0.14 / 1.0 / 1.7.
 * The parent is a handle you drag vertically; each mass follows through the
 * exact closed-form step. The step-rate slider throttles how often the engine
 * is stepped: the traces keep the same shape, only the sample density changes.
 * ========================================================================== */

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const ZETA = [0.14, 1.0, 1.7];
const LABEL = ["under", "critical", "over"];
const COLOR = ["#f0a070", "#e8e2d4", "#7fb0e0"];
const PX_PER_UNIT = 150;
const TRACE_SEC = 6;
const TRACE_N = 1024;

const engines = ZETA.map((z) => {
  const p = createJigglePhysics({ bones: 1, seed: 1 });
  const b = p.bones[0];
  b.mk = 1; b.mc = 1; b.gg = 0;
  p.params.damp = z;
  p.params.g = 0;
  return p;
});
const driver = createJiggleDriver({ tau: 0.012 });

let handle = 0;                    // parent position (world units, +y up)
let rate = 60, acc = 0;
const pos = [0, 0, 0];
const traceT = new Float32Array(TRACE_N);
const traceX = ZETA.map(() => new Float32Array(TRACE_N));
let traceHead = 0, traceLen = 0;

function setFreq(v) { for (let i = 0; i < engines.length; i++) engines[i].params.freq = v; }

function bindSlider(id, set, digits) {
  const el = document.getElementById(id), out = document.getElementById(id + "V");
  const sync = () => { set(parseFloat(el.value)); out.textContent = parseFloat(el.value).toFixed(digits); };
  el.addEventListener("input", sync);
  sync();
}
bindSlider("kFreq", setFreq, 2);
bindSlider("kRate", (v) => rate = v, 0);

function shake() { for (let i = 0; i < engines.length; i++) engines[i].shake(); }
function reset() {
  handle = 0; pos[1] = 0; acc = 0;
  driver.reset(pos);
  for (let i = 0; i < engines.length; i++) engines[i].reset();
  traceHead = 0; traceLen = 0;
}
document.getElementById("bShake").addEventListener("click", shake);
document.getElementById("bReset").addEventListener("click", reset);
window.addEventListener("keydown", (e) => {
  if (e.key === " ") shake();
  else if (e.key === "r" || e.key === "R") reset();
  else return;
  e.preventDefault();
});

let dragging = false;
function handleFromEvent(e) {
  const lim = (canvas.height * 0.32) / PX_PER_UNIT;
  handle = Math.max(-lim, Math.min(lim, -(e.clientY - canvas.height / 2) / PX_PER_UNIT));
}
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  dragging = true; document.body.classList.add("dragging");
  handleFromEvent(e); e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => { if (dragging) handleFromEvent(e); });
function endDrag() { dragging = false; document.body.classList.remove("dragging"); }
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function resize() {
  const w = innerWidth, h = innerHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
window.addEventListener("resize", resize);
resize();

function stepEngines(dt, tSec) {
  pos[1] = handle;
  const a = driver.update(dt, pos);
  traceT[traceHead] = tSec;
  for (let i = 0; i < engines.length; i++) traceX[i][traceHead] = engines[i].update(dt, a)[1];
  traceHead = (traceHead + 1) % TRACE_N;
  traceLen = Math.min(traceLen + 1, TRACE_N);
}

function draw(tSec) {
  const W = canvas.width, H = canvas.height, cy = H / 2;
  ctx.fillStyle = "#050507"; ctx.fillRect(0, 0, W, H);

  const left = W * 0.08, colW = W * 0.09;
  const traceX0 = W * 0.42, traceW = W * 0.50;
  const hy = cy - handle * PX_PER_UNIT;

  ctx.strokeStyle = "rgba(232,226,212,0.16)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left - colW * 0.5, hy); ctx.lineTo(left + colW * 2.5, hy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(traceX0, cy); ctx.lineTo(traceX0 + traceW, cy); ctx.stroke();

  ctx.font = "12px 'Iowan Old Style', Palatino, serif";
  ctx.textAlign = "center";
  for (let i = 0; i < engines.length; i++) {
    const x = left + colW * i;
    const y = hy - engines[i].offsets[1] * PX_PER_UNIT;
    ctx.strokeStyle = "rgba(232,226,212,0.25)";
    ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = COLOR[i];
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(232,226,212,0.55)";
    ctx.fillText(LABEL[i] + " ζ " + ZETA[i], x, cy + H * 0.36);
  }

  for (let i = 0; i < engines.length; i++) {
    ctx.strokeStyle = COLOR[i]; ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < traceLen; k++) {
      const idx = (traceHead - traceLen + k + TRACE_N) % TRACE_N;
      const age = tSec - traceT[idx];
      if (age > TRACE_SEC) continue;
      const px = traceX0 + traceW * (1 - age / TRACE_SEC);
      const py = cy - traceX[i][idx] * PX_PER_UNIT;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(232,226,212,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("offset vs time · " + rate + " Hz steps", traceX0 + traceW, cy + H * 0.36);
}

const start = performance.now();
let last = start;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  const tSec = (now - start) / 1000;
  acc += dt;
  const period = 1 / rate;
  if (acc >= period) { stepEngines(acc, tSec); acc = 0; }
  draw(tSec);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
