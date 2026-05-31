"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — UI/UX + rendering glue.
 * https://github.com/xloveee/jiggle-physics
 *
 * This file owns everything the user touches and everything drawn: WebGL setup,
 * the orbit camera, weight painting, DOM controls and the render loop. The
 * actual soft-body dynamics live in jiggle-physics.js (createJigglePhysics),
 * which this file feeds the parent state each frame and reads bone offsets from.
 * Keeping the two apart means the physics can be reused in any renderer.
 * ========================================================================== */

const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });

if (!gl) {
  document.getElementById("head").textContent = "WebGL is required for this demo.";
} else {
  bootstrap();
}

// --- tiny vec3 helpers (camera / body motion) ------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function bootstrap() {
  // ---- physics engine (pure simulation; see jiggle-physics.js) -----------
  const physics = createJigglePhysics({ bones: 3 });
  const P = physics.params;
  const NBONE = physics.NBONE;

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
  const uWTex = U("u_wTex"), uFTex = U("u_fTex"), uHasWeights = U("u_hasWeights");

  // ---- camera (the jiggle driver) ----------------------------------------
  const body = { x: 0, y: 0, z: 0 };
  const BODY_LIMIT = 5.0;
  let yaw = 0.6, pitch = 0.5, zoom = 1.0;
  const PITCH_LIMIT_LO = -0.1, PITCH_LIMIT_HI = 1.35;

  // ---- weight paint: per-geometry auto-unwrap texture --------------------
  const WMAP_W = 512, WMAP_H = 256;
  const TAU = 2 * Math.PI;
  const UV_PROJ = ["sphere", "cylinder", "torus", "cylinder", "cylinder"];
  const wmapSrc = new Uint8Array(WMAP_W * WMAP_H * 4);
  const wmap = new Uint8Array(WMAP_W * WMAP_H * 4);
  const fmap = new Uint8Array(WMAP_W * WMAP_H * 4);
  const blurTmp = new Uint8Array(WMAP_W * WMAP_H * 4);
  let brushR = 0.15, forceR = 0.15, brushStrength = 0.86;
  let brushSign = 1;
  let gainAll = 1.0;
  const boneGain = [1.0, 1.0, 1.0];
  let wmapDirty = true, hasWeights = false;
  let strokeBone = 0, strokeCount = 0;
  let strokeDist = 0, lastUv = null;
  const FLOW = 0.34;
  const DAB_SPACING = 0.55;

  const uvCanvas = document.getElementById("uvCanvas");
  const uvTitle = document.getElementById("uvTitle");
  const uvCtx = uvCanvas.getContext("2d");
  const dispW = uvCanvas.width, dispH = uvCanvas.height;
  const dispImg = uvCtx.createImageData(dispW, dispH);

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WMAP_W, WMAP_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, wmap);
    return t;
  }
  const wTex = makeTex();
  const fTex = makeTex();

  // Smart-UV-style projection per geometry (must match shader shapeToUV).
  function shapeToUV(x, y, z, g) {
    if (g === 0) {
      const l = Math.hypot(x, y, z) || 1;
      const dx = x / l, dy = y / l, dz = z / l;
      return [Math.atan2(dz, dx) / TAU + 0.5, Math.acos(Math.max(-1, Math.min(1, dy))) / Math.PI];
    }
    if (g === 1) {
      return [Math.atan2(x, z) / TAU + 0.5, Math.max(0, Math.min(1, (y + 0.5) / 1.0))];
    }
    if (g === 2) {
      const rho = Math.hypot(x, z);
      return [Math.atan2(x, z) / TAU + 0.5, Math.atan2(y, rho - 0.66) / TAU + 0.5];
    }
    if (g === 3) {
      return [Math.atan2(x, z) / TAU + 0.5, Math.max(0, Math.min(1, (y + 1.0) / 2.0))];
    }
    return [Math.atan2(x, z) / TAU + 0.5, Math.max(0, Math.min(1, (y + 0.95) / 1.79))];
  }

  function combineW(r, g, b) {
    return 1 - (1 - r) * (1 - g) * (1 - b);
  }

  function weightColor(w) {
    const t = Math.max(0, Math.min(1, w));
    let r, g, b;
    if (t <= 0.5) {
      const s = t / 0.5;
      r = 0.12 + (0.10 - 0.12) * s;
      g = 0.25 + (0.80 - 0.25) * s;
      b = 0.85 + (0.45 - 0.85) * s;
    } else {
      const s = (t - 0.5) / 0.5;
      r = 0.10 + (0.95 - 0.10) * s;
      g = 0.80 + (0.28 - 0.80) * s;
      b = 0.45 + (0.14 - 0.45) * s;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function scanHasWeights() {
    for (let i = 0; i < WMAP_W * WMAP_H * 4; i += 4) {
      if (wmapSrc[i] > 2 || wmapSrc[i + 1] > 2 || wmapSrc[i + 2] > 2) return true;
    }
    return false;
  }

  function applyGains() {
    for (let i = 0; i < WMAP_W * WMAP_H; i++) {
      const p = i * 4;
      wmap[p]     = Math.min(255, Math.round(wmapSrc[p]     * boneGain[0] * gainAll));
      wmap[p + 1] = Math.min(255, Math.round(wmapSrc[p + 1] * boneGain[1] * gainAll));
      wmap[p + 2] = Math.min(255, Math.round(wmapSrc[p + 2] * boneGain[2] * gainAll));
      wmap[p + 3] = 255;
    }
  }

  function resetGains() {
    gainAll = 1.0;
    boneGain[0] = boneGain[1] = boneGain[2] = 1.0;
    const gAll = document.getElementById("gAll");
    const g0 = document.getElementById("gBone0");
    const g1 = document.getElementById("gBone1");
    const g2 = document.getElementById("gBone2");
    gAll.value = g0.value = g1.value = g2.value = "1";
    document.getElementById("gAllV").textContent = "1.00";
    document.getElementById("gBone0V").textContent = "1.00";
    document.getElementById("gBone1V").textContent = "1.00";
    document.getElementById("gBone2V").textContent = "1.00";
  }

  function blurChannel(src, dst, ch, radius) {
    const r = Math.max(1, Math.floor(radius));
    const w = WMAP_W, h = WMAP_H;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let k = -r; k <= r; k++) {
          const sx = (x + k + w) % w;
          sum += src[(y * w + sx) * 4 + ch];
          cnt++;
        }
        blurTmp[(y * w + x) * 4 + ch] = Math.round(sum / cnt);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let k = -r; k <= r; k++) {
          const sy = Math.max(0, Math.min(h - 1, y + k));
          sum += blurTmp[(sy * w + x) * 4 + ch];
          cnt++;
        }
        dst[(y * w + x) * 4 + ch] = Math.round(sum / cnt);
      }
    }
  }

  function blurWeights() {
    fmap.set(wmap);
    const rad = Math.max(1, forceR * WMAP_W * 0.35);
    for (let ch = 0; ch < 3; ch++) blurChannel(wmap, fmap, ch, rad);
    for (let i = 3; i < fmap.length; i += 4) fmap[i] = 255;
  }

  function drawWmapDisplay() {
    const data = dispImg.data;
    for (let y = 0; y < dispH; y++) {
      for (let x = 0; x < dispW; x++) {
        const u = x / dispW, v = y / dispH;
        const tx = Math.min(WMAP_W - 1, Math.floor(u * WMAP_W));
        const ty = Math.min(WMAP_H - 1, Math.floor(v * WMAP_H));
        const si = (ty * WMAP_W + tx) * 4;
        const r = wmap[si] / 255, g = wmap[si + 1] / 255, b = wmap[si + 2] / 255;
        const w = combineW(r, g, b);
        const c = weightColor(w);
        const di = (y * dispW + x) * 4;
        data[di] = c[0]; data[di + 1] = c[1]; data[di + 2] = c[2]; data[di + 3] = 255;
      }
    }
    uvCtx.putImageData(dispImg, 0, 0);
    uvCtx.strokeStyle = "rgba(232,226,212,0.12)";
    uvCtx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * dispW;
      uvCtx.beginPath(); uvCtx.moveTo(x, 0); uvCtx.lineTo(x, dispH); uvCtx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * dispH;
      uvCtx.beginPath(); uvCtx.moveTo(0, y); uvCtx.lineTo(dispW, y); uvCtx.stroke();
    }
  }

  function uploadWeights() {
    applyGains();
    hasWeights = scanHasWeights() && (gainAll > 0.001);
    blurWeights();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WMAP_W, WMAP_H, gl.RGBA, gl.UNSIGNED_BYTE, wmap);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WMAP_W, WMAP_H, gl.RGBA, gl.UNSIGNED_BYTE, fmap);
    drawWmapDisplay();
    wmapDirty = false;
  }

  function clearWmap() {
    wmapSrc.fill(0);
    for (let i = 3; i < wmapSrc.length; i += 4) wmapSrc[i] = 255;
    wmapDirty = true;
  }

  function wrapDist(a, b, size) {
    let d = a - b;
    if (d > size * 0.5) d -= size;
    if (d < -size * 0.5) d += size;
    return d;
  }

  function splat(u, v, bone) {
    const ch = bone;
    const cx = u * WMAP_W, cy = v * WMAP_H;
    const rad = brushR * WMAP_W * 0.5;
    const r2 = rad * rad;
    // Gaussian sigma narrower than the cutoff radius so the falloff reaches ~0
    // at the edge (a hard 1-sigma cut left a visible disc rim on the surface).
    const invSig2 = 1 / (rad * rad * 0.18);
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(WMAP_H - 1, Math.ceil(cy + rad));
    const xRad = Math.ceil(rad);

    for (let iy = y0; iy <= y1; iy++) {
      const dy = iy - cy;
      for (let j = -xRad; j <= xRad; j++) {
        const ix = ((Math.floor(cx) + j) % WMAP_W + WMAP_W) % WMAP_W;
        const dx = wrapDist(ix, cx, WMAP_W);
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const g = Math.exp(-d2 * invSig2);
        const idx = (iy * WMAP_W + ix) * 4 + ch;
        let mag = wmapSrc[idx] / 255;
        if (brushSign > 0) mag += (brushStrength - mag) * FLOW * g;
        else mag *= (1 - FLOW * g);
        wmapSrc[idx] = Math.max(0, Math.min(255, Math.round(mag * 255)));
      }
    }
    wmapDirty = true;
  }

  function splatAtXYZ(x, y, z, bone, strength) {
    const prev = brushStrength;
    if (strength !== undefined) brushStrength = strength;
    const uv = shapeToUV(x, y, z, geo);
    splat(uv[0], uv[1], bone);
    brushStrength = prev;
  }

  // Paint a full-circumference latitude band (all u) with a gaussian profile in
  // v, peaking at `weight`. Reaches the target directly (max-combine) so demo
  // presets read at full strength, unlike the flow-limited interactive brush.
  function ringUV(bone, vCenter, vSigma, weight) {
    const inv = 1 / (vSigma * vSigma);
    for (let row = 0; row < WMAP_H; row++) {
      const v = (row + 0.5) / WMAP_H;
      const dv = v - vCenter;
      const g = Math.exp(-dv * dv * inv);
      if (g < 0.01) continue;
      const val = Math.round(Math.min(1, weight * g) * 255);
      for (let col = 0; col < WMAP_W; col++) {
        const idx = (row * WMAP_W + col) * 4 + bone;
        if (val > wmapSrc[idx]) wmapSrc[idx] = val;
      }
    }
  }

  // Paint a localized gaussian lobe at (u, v), reaching `weight` at its centre.
  function stampUV(u, v, bone, weight, radius) {
    const cx = u * WMAP_W, cy = v * WMAP_H;
    const rad = radius * WMAP_W * 0.5;
    const r2 = rad * rad;
    const invSig2 = 1 / (rad * rad * 0.18);
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(WMAP_H - 1, Math.ceil(cy + rad));
    const xRad = Math.ceil(rad);
    for (let iy = y0; iy <= y1; iy++) {
      const dy = iy - cy;
      for (let j = -xRad; j <= xRad; j++) {
        const ix = ((Math.floor(cx) + j) % WMAP_W + WMAP_W) % WMAP_W;
        const dx = wrapDist(ix, cx, WMAP_W);
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const val = Math.round(Math.min(1, weight * Math.exp(-d2 * invSig2)) * 255);
        const idx = (iy * WMAP_W + ix) * 4 + bone;
        if (val > wmapSrc[idx]) wmapSrc[idx] = val;
      }
    }
  }

  function defaultWeights(g) {
    clearWmap();

    if (g === 0) {
      // orb (sphere UV: v=0 north pole, v=1 south pole): a heavy sagging bottom
      // (bone 0) and a softer equatorial belly (bone 1), poles left anchored —
      // the two bands wobble out of sync, the bottom reading the gravity sag.
      ringUV(0, 0.82, 0.22, 1.0);
      ringUV(1, 0.50, 0.12, 0.65);
    } else if (g === 1) {
      // capsule (cylinder UV: v=0 bottom cap, v=1 top): a heavy hanging bottom
      // (bone 0) and a lighter mid belly (bone 1).
      ringUV(0, 0.07, 0.14, 1.0);
      ringUV(1, 0.46, 0.12, 0.60);
    } else if (g === 2) {
      // torus (torus UV: v=0.5 outer rim, u = ring angle): three soft lobes
      // evenly spaced around the outer rim, each on its own bone.
      stampUV(0.17, 0.50, 0, 1.0, 0.22);
      stampUV(0.50, 0.50, 1, 1.0, 0.22);
      stampUV(0.83, 0.50, 2, 1.0, 0.22);
    } else if (g === 3) {
      // air dancer (cylinder UV: v=0 feet, v=1 head): three stacked rings,
      // head-heavy, feet anchored — each whips on its own bone.
      ringUV(0, 0.90, 0.09, 1.0);
      ringUV(1, 0.66, 0.09, 0.80);
      ringUV(2, 0.42, 0.10, 0.55);
    } else {
      // walker: soft bust (bone 0), glutes (bone 1), groin (bone 2)
      const prevR = brushR, prevS = brushSign;
      brushR = 0.16; brushSign = 1;
      splatAtXYZ(-0.105, 0.345, 0.135, 0, 1.0);
      splatAtXYZ(0.105, 0.345, 0.135, 0, 1.0);
      splatAtXYZ(-0.105, -0.10, -0.115, 1, 1.0);
      splatAtXYZ(0.105, -0.10, -0.115, 1, 1.0);
      splatAtXYZ(0, -0.12, 0.13, 2, 0.85);
      brushR = prevR; brushSign = prevS;
    }

    wmapDirty = true;
  }

  function randomPaint() {
    physics.reseed();
    clearWmap();
    const n = 6 + Math.floor(Math.random() * 8);
    const prevR = brushR, prevS = brushSign, prevStr = brushStrength;
    brushR = 0.08 + Math.random() * 0.12; brushSign = 1;
    for (let i = 0; i < n; i++) {
      brushStrength = 0.25 + Math.random() * 0.45;
      splat(Math.random(), Math.random(), Math.floor(Math.random() * NBONE));
    }
    brushR = prevR; brushSign = prevS; brushStrength = prevStr;
    setShow(true);
    consumedHint();
  }

  function uvFromEvent(e) {
    const rect = uvCanvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [u, v];
  }

  function paintUv(u, v, newStroke) {
    if (newStroke) {
      strokeBone = strokeCount % NBONE;
      strokeCount++;
      strokeDist = 0;
      splat(u, v, strokeBone);
      lastUv = [u, v];
    } else if (lastUv) {
      const du = u - lastUv[0], dv = v - lastUv[1];
      const seg = Math.hypot(du, dv);
      const spacing = brushR * DAB_SPACING;
      if (seg > 1e-6) {
        let next = spacing - strokeDist;
        for (; next <= seg; next += spacing) {
          const f = next / seg;
          splat(lastUv[0] + du * f, lastUv[1] + dv * f, strokeBone);
        }
        strokeDist = seg - (next - spacing);
        lastUv = [u, v];
      }
    }
  }

  // ---- camera ray for orbit (no 3D paint) --------------------------------
  function cameraBasis() {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const R = 3.4 * zoom;
    const ro = [R * sy * cp, R * sp, R * cy * cp];
    const ww = norm(sub([0, -0.05, 0], ro));
    const uu = norm(cross(ww, [0, 1, 0]));
    const vv = cross(uu, ww);
    return { uu, vv };
  }

  const clampAxis = (v) => Math.max(-BODY_LIMIT, Math.min(BODY_LIMIT, v));
  function moveBodyScreen(dx, dy) {
    const { uu, vv } = cameraBasis();
    const s = 0.0052 / zoom;
    body.x = clampAxis(body.x + (uu[0] * dx - vv[0] * dy) * s);
    body.y = clampAxis(body.y + (uu[1] * dx - vv[1] * dy) * s);
    body.z = clampAxis(body.z + (uu[2] * dx - vv[2] * dy) * s);
  }

  // ---- DOM / controls ----------------------------------------------------
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
  const hint = document.getElementById("hint");

  const GEO_NAMES = ["Orb", "Capsule", "Torus", "Air Dancer", "Walker"];
  let geo = 0, paintMode = false, showWeights = true;

  let hintArmed = true;
  function consumedHint() { if (hintArmed) { hintArmed = false; hint.classList.add("gone"); } }

  function applyBrushWeight(v) { brushStrength = v; }

  function setBrushSign(sign) {
    brushSign = sign < 0 ? -1 : 1;
    bBrushAdd.classList.toggle("on", brushSign > 0);
    bBrushSub.classList.toggle("on", brushSign < 0);
    consumedHint();
  }

  function setGeo(g) {
    geo = g; elGeoName.textContent = GEO_NAMES[geo];
    bGeo.textContent = "geometry: " + GEO_NAMES[geo].toLowerCase();
    uvTitle.textContent = "weight map · " + UV_PROJ[geo];
    defaultWeights(geo);
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

  function clearWeights() {
    clearWmap(); resetGains(); lastUv = null; strokeDist = 0; consumedHint();
  }

  function shake() { physics.shake(); consumedHint(); }

  function reset() {
    body.x = body.y = body.z = 0;
    yaw = 0.6; pitch = 0.5; zoom = 1.0;
    physics.reset({ yaw, pitch, body });
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

  function bindSlider(id, set, digits) {
    const el = document.getElementById(id), out = document.getElementById(id + "V");
    const sync = () => { set(parseFloat(el.value)); out.textContent = parseFloat(el.value).toFixed(digits); };
    el.addEventListener("input", () => { sync(); consumedHint(); });
    sync();
  }
  bindSlider("kStiff", (v) => P.k = v, 0);
  bindSlider("kDamp", (v) => P.c = v, 1);
  bindSlider("kMass", (v) => P.m = v, 2);
  bindSlider("kGrav", (v) => P.g = v, 1);
  bindSlider("oDrive", (v) => P.orbit = v, 1);
  bindSlider("bSize", (v) => { brushR = v; }, 2);
  bindSlider("bWeight", (v) => applyBrushWeight(v), 2);
  bindSlider("fRadius", (v) => { forceR = v; wmapDirty = true; }, 2);

  bindSlider("gAll", (v) => { gainAll = v; wmapDirty = true; }, 2);
  bindSlider("gBone0", (v) => { boneGain[0] = v; wmapDirty = true; }, 2);
  bindSlider("gBone1", (v) => { boneGain[1] = v; wmapDirty = true; }, 2);
  bindSlider("gBone2", (v) => { boneGain[2] = v; wmapDirty = true; }, 2);

  // ---- UV paint window pointer input -------------------------------------
  let uvAction = false;
  uvCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
  uvCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !paintMode) return;
    uvCanvas.setPointerCapture(e.pointerId);
    uvAction = true;
    const uv = uvFromEvent(e);
    if (uv) paintUv(uv[0], uv[1], true);
    consumedHint();
    e.preventDefault();
  });
  uvCanvas.addEventListener("pointermove", (e) => {
    if (!uvAction) return;
    const uv = uvFromEvent(e);
    if (uv) paintUv(uv[0], uv[1], false);
  });
  function endUvPointer() {
    if (uvAction) { lastUv = null; strokeDist = 0; }
    uvAction = false;
  }
  uvCanvas.addEventListener("pointerup", endUvPointer);
  uvCanvas.addEventListener("pointercancel", endUvPointer);

  // ---- 3D viewport pointer input (orbit / move only) ---------------------
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
    } else if (action === "move") {
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
    else if (e.key === "r" || e.key === "R") reset();
    else if (e.key === "ArrowLeft") yaw -= 0.12;
    else if (e.key === "ArrowRight") yaw += 0.12;
    else if (e.key === "ArrowUp") pitch = Math.min(PITCH_LIMIT_HI, pitch + 0.1);
    else if (e.key === "ArrowDown") pitch = Math.max(PITCH_LIMIT_LO, pitch - 0.1);
    else return;
    e.preventDefault();
  });

  // ---- resize ------------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.0);
    const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener("resize", resize);
  resize();
  setGeo(0); setShow(true);

  // ---- render loop -------------------------------------------------------
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
    const driveBody = { x: body.x, y: body.y + animY, z: body.z };
    const jig = physics.update(dt, { yaw, pitch, body: driveBody });

    if (wmapDirty) uploadWeights();

    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, tSec);
    gl.uniform3fv(uJig, jig);
    gl.uniform3f(uBody, body.x, body.y, body.z);
    gl.uniform1f(uGeo, geo);
    gl.uniform1f(uPaint, showWeights ? 1 : 0);
    gl.uniform1f(uYaw, yaw);
    gl.uniform1f(uPitch, pitch);
    gl.uniform1f(uZoom, zoom);
    gl.uniform1f(uHasWeights, hasWeights ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wTex);
    gl.uniform1i(uWTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fTex);
    gl.uniform1i(uFTex, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---- shader helpers ------------------------------------------------------
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
