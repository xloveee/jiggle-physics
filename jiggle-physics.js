"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — pure, dependency-free jiggle-bone reference engine.
 * https://github.com/xloveee/jiggle-physics
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * No DOM, no WebGL. One damped spring ("jiggle bone") per region; a painted
 * weight in [0,1] scales how much each vertex follows it:
 *
 *     vertex += Σ_b weight_b * offset_b
 *
 * Each bone obeys the damped oscillator in the parent's accelerating frame:
 *
 *     x'' = -ω² x - 2ζω x' - a_parent + g
 *
 * The step is the exact closed-form solution, so it is stable for any dt and
 * defines the reference output rather than approximating it. Parameters are
 * the observable pair (frequency ω, damping ratio ζ); mass is not observable.
 *
 * Usage:
 *   const physics = createJigglePhysics({ bones: 3, seed: 1 });
 *   const offsets = physics.update(dt, [ax, ay, az]);   // parent acceleration
 *   // offsets: Float32Array(bones*3) = [x0,y0,z0, x1,y1,z1, ...]
 *
 * Hosts that only have a parent position can derive acceleration with
 * createJiggleDriver (finite difference + smoothing).
 *
 * Extensions live beside this file and never alter the step:
 *   jiggle-colliders.js — post-step constraint projection (plane/sphere/capsule)
 *   jiggle-chain.js     — linked bones, acceleration propagates down the chain
 * ========================================================================== */

const JIGGLE_PHYSICS_META = {
  standard: "xlovecam-jiggle-physics",
  author: "xlovecam",
  repository: "https://github.com/xloveee/jiggle-physics",
  demo: "https://xloveee.github.io/jiggle-physics/"
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function freshSeed() {
  return (Math.random() * 0x100000000) >>> 0;
}

function createJigglePhysics(opts) {
  opts = opts || {};
  const NBONE = opts.bones || 3;
  const TAU = 2 * Math.PI;
  let seed = opts.seed !== undefined ? (opts.seed >>> 0) : freshSeed();
  let rng = mulberry32(seed);

  // Tunable parameters (the UI mutates these in place).
  // freq: natural frequency in Hz. damp: damping ratio ζ. g: gravity (accel, -y).
  const P = { freq: 1.9, damp: 0.14, g: 2.7 };

  const bones = [];
  const offsets = new Float32Array(NBONE * 3);
  // size = relative mass of the region the bone stands for (host-set, default 1).
  // Tissue k and c are shared, so ω and ζ both scale by 1/sqrt(size): a larger
  // region wobbles slower, is less damped, and moves further.
  for (let i = 0; i < NBONE; i++) {
    bones.push({ x: [0, 0, 0], v: [0, 0, 0], mk: 1, mc: 1, gg: 0.8, size: 1 });
  }
  const eq = [0, 0, 0];

  // Seed each bone's character so painted regions never wobble in lockstep.
  function reseed(s) {
    seed = s === undefined ? freshSeed() : (s >>> 0);
    rng = mulberry32(seed);
    const rnd = (a, b) => a + rng() * (b - a);
    for (let i = 0; i < NBONE; i++) {
      const b = bones[i];
      b.mk = rnd(0.45, 1.9);   // frequency multiplier
      b.mc = rnd(0.6, 1.5);    // damping multiplier
      b.gg = rnd(0.4, 1.25);   // gravity-sag scale
    }
  }
  reseed(seed);

  // Exact damped-oscillator step over h with constant external acceleration:
  // shift to the equilibrium offset, advance the homogeneous solution, shift back.
  function stepBone(J, h, ax, ay, az) {
    const inv = 1 / Math.sqrt(Math.max(J.size, 1e-4));
    const w = Math.max(TAU * P.freq * J.mk * inv, 1e-3);
    const z = Math.max(P.damp * J.mc * inv, 0);
    const w2 = w * w, zw = z * w;
    eq[0] = -ax / w2;
    eq[1] = (-ay - P.g * J.gg) / w2;
    eq[2] = -az / w2;
    const e = Math.exp(-zw * h);
    let c, s;
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z);
      c = Math.cos(wd * h); s = Math.sin(wd * h) / wd;
    } else {
      const wd = w * Math.sqrt(z * z - 1);
      c = Math.cosh(wd * h); s = wd > 1e-6 ? Math.sinh(wd * h) / wd : h;
    }
    for (let i = 0; i < 3; i++) {
      const x = J.x[i] - eq[i], v = J.v[i];
      J.x[i] = e * (x * c + (v + zw * x) * s) + eq[i];
      J.v[i] = e * (v * c - (w2 * x + zw * v) * s);
    }
  }

  // Advance one bone with its own parent acceleration (chains feed each link
  // a different one). Offsets are repacked by pack().
  function step(i, dt, ax, ay, az) {
    stepBone(bones[i], Math.max(dt, 0), ax, ay, az);
  }

  function pack() {
    for (let i = 0; i < NBONE; i++) {
      const x = bones[i].x;
      offsets[i * 3] = x[0]; offsets[i * 3 + 1] = x[1]; offsets[i * 3 + 2] = x[2];
    }
    return offsets;
  }

  function update(dt, accel) {
    for (let i = 0; i < NBONE; i++) step(i, dt, accel[0], accel[1], accel[2]);
    return pack();
  }

  function shake() {
    for (let i = 0; i < NBONE; i++) {
      const v = bones[i].v;
      v[0] += (rng() - 0.5) * 11;
      v[1] += (rng() - 0.5) * 11;
      v[2] += (rng() - 0.5) * 11;
    }
  }

  function reset() {
    for (let i = 0; i < NBONE; i++) { bones[i].x.fill(0); bones[i].v.fill(0); }
    offsets.fill(0);
  }

  // bones exposes {x, v} state for extensions (colliders, chains).
  return {
    NBONE, params: P, offsets, bones, meta: JIGGLE_PHYSICS_META,
    get seed() { return seed; },
    update, step, pack, shake, reset, reseed
  };
}

// Parent position -> parent acceleration. Finite difference with exponential
// velocity smoothing (tau seconds) so quantized input does not spike the bones.
function createJiggleDriver(opts) {
  const tau = (opts && opts.tau) || 0.012;
  const accel = new Float32Array(3);
  const vel = [0, 0, 0], prev = [0, 0, 0];
  let primed = false;

  function reset(pos) {
    vel.fill(0); accel.fill(0);
    primed = !!pos;
    if (pos) { prev[0] = pos[0]; prev[1] = pos[1]; prev[2] = pos[2]; }
  }

  function update(dt, pos) {
    const h = Math.max(dt, 1e-4);
    if (!primed) reset(pos);
    const blend = 1 - Math.exp(-h / tau);
    for (let i = 0; i < 3; i++) {
      const raw = (pos[i] - prev[i]) / h;
      prev[i] = pos[i];
      const nv = vel[i] + (raw - vel[i]) * blend;
      accel[i] = (nv - vel[i]) / h;
      vel[i] = nv;
    }
    return accel;
  }

  return { update, reset };
}

if (typeof window !== "undefined") {
  window.createJigglePhysics = createJigglePhysics;
  window.createJiggleDriver = createJiggleDriver;
  window.JIGGLE_PHYSICS_META = JIGGLE_PHYSICS_META;
}
