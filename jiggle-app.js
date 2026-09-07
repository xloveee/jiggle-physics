"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — UI/UX + rendering glue.
 * https://github.com/xloveee/jiggle-physics
 *
 * This file owns everything the user touches and everything drawn: WebGL setup,
 * the orbit camera, DOM controls and the render loop. Soft-body dynamics live
 * in jiggle-physics.js; the UV weight map lives in jiggle-weightmap.js.
 * ========================================================================== */

const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });

if (!gl) {
  document.getElementById("head").textContent = "WebGL is required for this demo.";
} else {
  bootstrap();
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function bootstrap() {
  const physics = createJigglePhysics({ bones: 3 });
  const driver = createJiggleDriver({ tau: 0.012 });
  const P = physics.params;
  const NBONE = physics.NBONE;
  // Colliders: offsets confined to 0.4 (ray-march safety) and the ground plane
  // at y = -1. Painted regions sit FLOOR_GAP above the floor per geometry, so
  // the shared rest point is body + (gap - 1) on y.
  const colliders = createJiggleColliders({ limit: 0.4 });
  colliders.plane(0, 1, 0, -1);
  const FLOOR_GAP = [0.28, 0.04, 0.70, 0.84, 0.75];

  const vsrc = "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}";
  const fsrc = document.getElementById("frag").textContent;
  const prog = link(compile(gl.VERTEX_SHADER, vsrc), compile(gl.FRAGMENT_SHADER, fsrc));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = (n) => gl.getUniformLocation(prog, n);
  const uRes = U("u_res"), uTime = U("u_time"), uJig = U("u_jig[0]"), uBody = U("u_body");
  const uGeo = U("u_geo"), uPaint = U("u_paint"), uYaw = U("u_yaw"), uPitch = U("u_pitch"), uZoom = U("u_zoom");
  const uHasWeights = U("u_hasWeights");

  const uvCanvas = document.getElementById("uvCanvas");
  const uvTitle = document.getElementById("uvTitle");
  const weights = createWeightMap(gl, uvCanvas);
  gl.uniform1i(U("u_wTex"), 0);
  gl.uniform1i(U("u_fTex"), 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, weights.wTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, weights.fTex);

  const body = { x: 0, y: 0, z: 0 };
  const BODY_LIMIT = 5.0;
  const BODY_GAIN = 0.22;                // object translation -> parent position
  let yaw = 0.6, pitch = 0.5, zoom = 1.0;
  let orbitDrive = 0.04;                 // orbit angle -> parent position (slider)
  const PITCH_LIMIT_LO = -0.1, PITCH_LIMIT_HI = 1.35;
  const drive = [0, 0, 0];
  let prevYaw = yaw, prevPitch = pitch;
  let prevDriveX = 0, prevDriveY = 0, prevDriveZ = 0;

  let brushR = 0.15, brushStrength = 0.86, brushSign = 1;
  let gainAll = 1.0;
  const boneGain = [1.0, 1.0, 1.0];

  function cameraBasis() {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const R = 3.4 * zoom;
    const ro = [R * sy * cp, R * sp, R * cy * cp];
    const ww = norm(sub([0, -0.05, 0], ro));
    const uu = norm(cross(ww, [0, 1, 0]));
    return { uu, vv: cross(uu, ww) };
  }

  const clampAxis = (v) => Math.max(-BODY_LIMIT, Math.min(BODY_LIMIT, v));
  function moveBodyScreen(dx, dy) {
    const { uu, vv } = cameraBasis();
    const s = 0.0052 / zoom;
    body.x = clampAxis(body.x + (uu[0] * dx - vv[0] * dy) * s);
    body.y = clampAxis(body.y + (uu[1] * dx - vv[1] * dy) * s);
    body.z = clampAxis(body.z + (uu[2] * dx - vv[2] * dy) * s);
  }

  const elGeoName = document.getElementById("geoName");
  const bGeo = document.getElementById("bGeo");
  const bPaint = document.getElementById("bPaint");
  const bBrushAdd = document.getElementById("bBrushAdd");
  const bBrushSub = document.getElementById("bBrushSub");
  const bShow = document.getElementById("bShow");
  const bRandom = document.getElementById("bRandom");
  const bShake = document.getElementById("bShake");
  const bClear = document.getElementById("bClear");
  const bReset = document.getElementById("bReset");
  const bExport = document.getElementById("bExport");
  const bImport = document.getElementById("bImport");
  const pngIn = document.getElementById("pngIn");
  const hint = document.getElementById("hint");

  const GEO_NAMES = ["Orb", "Capsule", "Torus", "Air Dancer", "Walker"];
  let geo = 0, paintMode = false, showWeights = true;
  let hasWeights = false;

  let hintArmed = true;
  function consumedHint() { if (hintArmed) { hintArmed = false; hint.classList.add("gone"); } }

  function syncBrush() { weights.setBrush(brushR, brushStrength, brushSign); }
  function syncGains() { weights.setGains(gainAll, boneGain); }

  function setBrushSign(sign) {
    brushSign = sign < 0 ? -1 : 1;
    syncBrush();
    bBrushAdd.classList.toggle("on", brushSign > 0);
    bBrushSub.classList.toggle("on", brushSign < 0);
    consumedHint();
  }

  function setGeo(g) {
    geo = g; elGeoName.textContent = GEO_NAMES[geo];
    bGeo.textContent = "geometry: " + GEO_NAMES[geo].toLowerCase();
    uvTitle.textContent = "weight map · " + weights.setGeo(geo);
    consumedHint();
  }

  function setPaintMode(on) {
    paintMode = on;
    document.body.classList.toggle("paint-mode", paintMode);
    bPaint.classList.toggle("on", paintMode);
    bPaint.textContent = paintMode ? "painting…" : "paint weights";
    if (paintMode) setShow(true);
    consumedHint();
  }

  function setShow(on) {
    showWeights = on; bShow.classList.toggle("on", showWeights);
    bShow.textContent = showWeights ? "hide weights" : "show weights";
  }

  function resetGainSliders() {
    gainAll = 1.0;
    boneGain[0] = boneGain[1] = boneGain[2] = 1.0;
    const ids = ["gAll", "gBone0", "gBone1", "gBone2"];
    for (let i = 0; i < ids.length; i++) {
      document.getElementById(ids[i]).value = "1";
      document.getElementById(ids[i] + "V").textContent = "1.00";
    }
    weights.resetGains();
  }

  function clearWeights() {
    weights.clear(); resetGainSliders(); consumedHint();
  }

  function randomPaint() {
    physics.reseed();
    weights.randomPaint(NBONE);
    setShow(true);
    consumedHint();
  }

  function exportPng() { weights.exportPng(physics.seed); consumedHint(); }

  function importPng(file) {
    if (!file) return;
    const m = file.name.match(/seed-(\d+)/);
    weights.importPng(file).then(function () {
      if (m) physics.reseed(+m[1]);
    });
    consumedHint();
  }

  function resetDrive() {
    drive[0] = drive[1] = drive[2] = 0;
    prevYaw = yaw; prevPitch = pitch;
    prevDriveX = body.x; prevDriveY = body.y; prevDriveZ = body.z;
    driver.reset(drive);
    physics.reset();
  }

  function shake() { physics.shake(); consumedHint(); }

  function reset() {
    body.x = body.y = body.z = 0;
    yaw = 0.6; pitch = 0.5; zoom = 1.0;
    resetDrive();
    consumedHint();
  }

  bGeo.addEventListener("click", () => setGeo((geo + 1) % GEO_NAMES.length));
  bPaint.addEventListener("click", () => setPaintMode(!paintMode));
  bBrushAdd.addEventListener("click", () => setBrushSign(1));
  bBrushSub.addEventListener("click", () => setBrushSign(-1));
  bShow.addEventListener("click", () => setShow(!showWeights));
  bRandom.addEventListener("click", randomPaint);
  bShake.addEventListener("click", shake);
  bClear.addEventListener("click", clearWeights);
  bReset.addEventListener("click", reset);
  bExport.addEventListener("click", exportPng);
  bImport.addEventListener("click", () => pngIn.click());
  pngIn.addEventListener("change", () => {
    importPng(pngIn.files[0]);
    pngIn.value = "";
  });

  function bindSlider(id, set, digits) {
    const el = document.getElementById(id), out = document.getElementById(id + "V");
    const sync = () => { set(parseFloat(el.value)); out.textContent = parseFloat(el.value).toFixed(digits); };
    el.addEventListener("input", () => { sync(); consumedHint(); });
    sync();
  }
  bindSlider("kFreq", (v) => P.freq = v, 2);
  bindSlider("kDamp", (v) => P.damp = v, 2);
  bindSlider("kGrav", (v) => P.g = v, 1);
  bindSlider("oDrive", (v) => orbitDrive = v, 3);
  bindSlider("bSize", (v) => { brushR = v; syncBrush(); }, 2);
  bindSlider("bWeight", (v) => { brushStrength = v; syncBrush(); }, 2);
  bindSlider("fRadius", (v) => weights.setForceRadius(v), 2);
  bindSlider("gAll", (v) => { gainAll = v; syncGains(); }, 2);
  bindSlider("gBone0", (v) => { boneGain[0] = v; syncGains(); }, 2);
  bindSlider("gBone1", (v) => { boneGain[1] = v; syncGains(); }, 2);
  bindSlider("gBone2", (v) => { boneGain[2] = v; syncGains(); }, 2);

  function uvFromEvent(e) {
    const rect = uvCanvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [u, v];
  }

  let uvAction = false;
  uvCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
  uvCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !paintMode) return;
    uvCanvas.setPointerCapture(e.pointerId);
    uvAction = true;
    const uv = uvFromEvent(e);
    if (uv) weights.paintUv(uv[0], uv[1], true, NBONE);
    consumedHint();
    e.preventDefault();
  });
  uvCanvas.addEventListener("pointermove", (e) => {
    if (!uvAction) return;
    const uv = uvFromEvent(e);
    if (uv) weights.paintUv(uv[0], uv[1], false, NBONE);
  });
  function endUvPointer() {
    if (uvAction) weights.endStroke();
    uvAction = false;
  }
  uvCanvas.addEventListener("pointerup", endUvPointer);
  uvCanvas.addEventListener("pointercancel", endUvPointer);

  let action = null, lastX = 0, lastY = 0;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    lastX = e.clientX; lastY = e.clientY;
    action = e.shiftKey ? "move" : "orbit";
    document.body.classList.toggle("dragging", true);
    consumedHint();
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!action) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (action === "orbit") {
      yaw += dx * 0.008;
      pitch = Math.min(PITCH_LIMIT_HI, Math.max(PITCH_LIMIT_LO, pitch + dy * 0.008));
    } else {
      moveBodyScreen(dx, dy);
    }
  });
  function endPointer() {
    action = null;
    document.body.classList.remove("dragging");
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  window.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom = Math.min(2.5, Math.max(0.5, zoom * Math.exp(e.deltaY * 0.0011)));
    consumedHint();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.key === "g" || e.key === "G") setGeo((geo + 1) % GEO_NAMES.length);
    else if (e.key === "p" || e.key === "P") setPaintMode(!paintMode);
    else if (e.key === "+" || e.key === "=") setBrushSign(1);
    else if (e.key === "-" || e.key === "_") setBrushSign(-1);
    else if (e.key === "w" || e.key === "W") setShow(!showWeights);
    else if (e.key === " ") shake();
    else if (e.key === "c" || e.key === "C") clearWeights();
    else if (e.key === "x" || e.key === "X") randomPaint();
    else if (e.key === "e" || e.key === "E") exportPng();
    else if (e.key === "i" || e.key === "I") pngIn.click();
    else if (e.key === "r" || e.key === "R") reset();
    else if (e.key === "ArrowLeft") yaw -= 0.12;
    else if (e.key === "ArrowRight") yaw += 0.12;
    else if (e.key === "ArrowUp") pitch = Math.min(PITCH_LIMIT_HI, pitch + 0.1);
    else if (e.key === "ArrowDown") pitch = Math.max(PITCH_LIMIT_LO, pitch - 0.1);
    else return;
    e.preventDefault();
  });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.0);
    const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
  }
  window.addEventListener("resize", resize);
  resize();
  setGeo(0); setShow(true);

  const start = performance.now();
  let last = start;
  const WALK_BOB = 0.22;
  let walkAmt = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const tSec = (now - start) / 1000;
    walkAmt += ((geo === 4 ? 1 : 0) - walkAmt) * (1 - Math.exp(-dt / 0.12));
    const animY = -Math.abs(Math.cos(tSec * 3.2)) * WALK_BOB * walkAmt;
    const bx = body.x, by = body.y + animY, bz = body.z;
    drive[0] += (yaw - prevYaw) * orbitDrive + (bx - prevDriveX) * BODY_GAIN;
    drive[1] += -(pitch - prevPitch) * orbitDrive + (by - prevDriveY) * BODY_GAIN;
    drive[2] += (bz - prevDriveZ) * BODY_GAIN;
    prevYaw = yaw; prevPitch = pitch;
    prevDriveX = bx; prevDriveY = by; prevDriveZ = bz;
    physics.update(dt, driver.update(dt, drive));
    const jig = colliders.resolveAll(physics, body.x, body.y + FLOOR_GAP[geo] - 1, body.z);

    hasWeights = weights.uploadIfDirty();

    gl.uniform1f(uTime, tSec);
    gl.uniform3fv(uJig, jig);
    gl.uniform3f(uBody, body.x, body.y, body.z);
    gl.uniform1f(uGeo, geo);
    gl.uniform1f(uPaint, showWeights ? 1 : 0);
    gl.uniform1f(uYaw, yaw);
    gl.uniform1f(uPitch, pitch);
    gl.uniform1f(uZoom, zoom);
    gl.uniform1f(uHasWeights, hasWeights ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}
function link(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "program link failed");
  return p;
}
