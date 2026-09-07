"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — UV weight map (paint, presets, PNG asset).
 * https://github.com/xloveee/jiggle-physics
 *
 * Owns the 512×256 RGBA weight texture (R/G/B = three bones), Smart-UV
 * projection, brush, force-radius blur, heatmap display, and PNG export/import.
 * No physics, no camera, no render loop.
 * ========================================================================== */

const WMAP_W = 512, WMAP_H = 256;
const UV_PROJ = ["sphere", "cylinder", "torus", "cylinder", "cylinder"];

function createWeightMap(gl, uvCanvas) {
  const TAU = 2 * Math.PI;
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
  let geo = 0;
  const FLOW = 0.34;
  const DAB_SPACING = 0.55;

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

  function applyGains() {
    const g0 = boneGain[0] * gainAll, g1 = boneGain[1] * gainAll, g2 = boneGain[2] * gainAll;
    let any = false;
    for (let i = 0; i < WMAP_W * WMAP_H; i++) {
      const p = i * 4;
      const r = Math.min(255, Math.round(wmapSrc[p]     * g0));
      const g = Math.min(255, Math.round(wmapSrc[p + 1] * g1));
      const b = Math.min(255, Math.round(wmapSrc[p + 2] * g2));
      wmap[p] = r; wmap[p + 1] = g; wmap[p + 2] = b; wmap[p + 3] = 255;
      if (r > 2 || g > 2 || b > 2) any = true;
    }
    hasWeights = any;
  }

  function resetGains() {
    gainAll = 1.0;
    boneGain[0] = boneGain[1] = boneGain[2] = 1.0;
    wmapDirty = true;
  }

  // Sliding-window box blur: O(W·H) per channel, same output as the old
  // nested-tap version (wrap in u, clamp-repeat in v, cnt = 2r+1).
  function blurChannel(src, dst, ch, radius) {
    const r = Math.max(1, Math.floor(radius));
    const w = WMAP_W, h = WMAP_H;
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const sx = ((k % w) + w) % w;
        sum += src[(row + sx) * 4 + ch];
      }
      for (let x = 0; x < w; x++) {
        blurTmp[(row + x) * 4 + ch] = Math.round(sum * inv);
        const xOut = ((x - r) % w + w) % w;
        const xIn = ((x + 1 + r) % w + w) % w;
        sum += src[(row + xIn) * 4 + ch] - src[(row + xOut) * 4 + ch];
      }
    }
    const sy = (y) => (y < 0 ? 0 : (y >= h ? h - 1 : y));
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += blurTmp[(sy(k) * w + x) * 4 + ch];
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 4 + ch] = Math.round(sum * inv);
        sum += blurTmp[(sy(y + 1 + r) * w + x) * 4 + ch]
             - blurTmp[(sy(y - r) * w + x) * 4 + ch];
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
        const tx = Math.min(WMAP_W - 1, Math.floor((x / dispW) * WMAP_W));
        const ty = Math.min(WMAP_H - 1, Math.floor((y / dispH) * WMAP_H));
        const si = (ty * WMAP_W + tx) * 4;
        const c = weightColor(combineW(wmap[si] / 255, wmap[si + 1] / 255, wmap[si + 2] / 255));
        const di = (y * dispW + x) * 4;
        data[di] = c[0]; data[di + 1] = c[1]; data[di + 2] = c[2]; data[di + 3] = 255;
      }
    }
    uvCtx.putImageData(dispImg, 0, 0);
    uvCtx.strokeStyle = "rgba(232,226,212,0.12)";
    uvCtx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const gx = (i / 8) * dispW;
      uvCtx.beginPath(); uvCtx.moveTo(gx, 0); uvCtx.lineTo(gx, dispH); uvCtx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      const gy = (i / 4) * dispH;
      uvCtx.beginPath(); uvCtx.moveTo(0, gy); uvCtx.lineTo(dispW, gy); uvCtx.stroke();
    }
  }

  function uploadIfDirty() {
    if (!wmapDirty) return hasWeights;
    applyGains();
    blurWeights();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WMAP_W, WMAP_H, gl.RGBA, gl.UNSIGNED_BYTE, wmap);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WMAP_W, WMAP_H, gl.RGBA, gl.UNSIGNED_BYTE, fmap);
    drawWmapDisplay();
    wmapDirty = false;
    return hasWeights;
  }

  function clear() {
    wmapSrc.fill(0);
    for (let i = 3; i < wmapSrc.length; i += 4) wmapSrc[i] = 255;
    lastUv = null; strokeDist = 0;
    wmapDirty = true;
  }

  function wrapDist(a, b, size) {
    let d = a - b;
    if (d > size * 0.5) d -= size;
    if (d < -size * 0.5) d += size;
    return d;
  }

  function splat(u, v, bone) {
    const cx = u * WMAP_W, cy = v * WMAP_H;
    const rad = brushR * WMAP_W * 0.5;
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
        const g = Math.exp(-d2 * invSig2);
        const idx = (iy * WMAP_W + ix) * 4 + bone;
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
    clear();
    if (g === 0) {
      ringUV(0, 0.82, 0.22, 1.0);
      ringUV(1, 0.50, 0.12, 0.65);
    } else if (g === 1) {
      ringUV(0, 0.07, 0.14, 1.0);
      ringUV(1, 0.46, 0.12, 0.60);
    } else if (g === 2) {
      stampUV(0.17, 0.50, 0, 1.0, 0.22);
      stampUV(0.50, 0.50, 1, 1.0, 0.22);
      stampUV(0.83, 0.50, 2, 1.0, 0.22);
    } else if (g === 3) {
      ringUV(0, 0.90, 0.09, 1.0);
      ringUV(1, 0.66, 0.09, 0.80);
      ringUV(2, 0.42, 0.10, 0.55);
    } else {
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

  function setGeo(g) {
    geo = g;
    defaultWeights(g);
    return UV_PROJ[g];
  }

  function setBrush(r, strength, sign) {
    if (r !== undefined) brushR = r;
    if (strength !== undefined) brushStrength = strength;
    if (sign !== undefined) brushSign = sign < 0 ? -1 : 1;
  }

  function setForceRadius(v) { forceR = v; wmapDirty = true; }

  function setGains(all, per) {
    if (all !== undefined) gainAll = all;
    if (per) { boneGain[0] = per[0]; boneGain[1] = per[1]; boneGain[2] = per[2]; }
    wmapDirty = true;
  }

  function paintUv(u, v, newStroke, nbone) {
    const n = nbone || 3;
    if (newStroke) {
      strokeBone = strokeCount % n;
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

  function endStroke() { lastUv = null; strokeDist = 0; }

  function randomPaint(nbone) {
    const n = nbone || 3;
    clear();
    const count = 6 + Math.floor(Math.random() * 8);
    const prevR = brushR, prevS = brushSign, prevStr = brushStrength;
    brushR = 0.08 + Math.random() * 0.12; brushSign = 1;
    for (let i = 0; i < count; i++) {
      brushStrength = 0.25 + Math.random() * 0.45;
      splat(Math.random(), Math.random(), Math.floor(Math.random() * n));
    }
    brushR = prevR; brushSign = prevS; brushStrength = prevStr;
  }

  function exportPng(seed) {
    const c = document.createElement("canvas");
    c.width = WMAP_W; c.height = WMAP_H;
    const ctx = c.getContext("2d");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(wmapSrc), WMAP_W, WMAP_H), 0, 0);
    c.toBlob(function (blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "jiggle-weights-seed-" + seed + ".png";
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  }

  function importPng(file) {
    return createImageBitmap(file).then(function (bmp) {
      const c = document.createElement("canvas");
      c.width = WMAP_W; c.height = WMAP_H;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0, WMAP_W, WMAP_H);
      wmapSrc.set(ctx.getImageData(0, 0, WMAP_W, WMAP_H).data);
      wmapDirty = true;
      bmp.close();
    });
  }

  return {
    wTex, fTex, setGeo, paintUv, endStroke, randomPaint, clear,
    setBrush, setForceRadius, setGains, resetGains, uploadIfDirty,
    exportPng, importPng
  };
}

if (typeof window !== "undefined") {
  window.createWeightMap = createWeightMap;
}
