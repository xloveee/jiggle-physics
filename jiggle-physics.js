"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — pure, dependency-free soft-body simulation engine.
 * https://github.com/xloveee/jiggle-physics
 *
 * No DOM, no WebGL: this file owns ONLY the dynamics so it can be dropped into
 * any renderer or game loop. The technique is one damped spring ("jiggle bone")
 * per region; a painted weight in [0,1] scales how much each vertex follows it:
 *
 *     vertex += weight * boneOffset;
 *
 * Each bone is driven two ways from the parent's motion:
 *   - a discrete IMPULSE on the change in parent velocity (acceleration), which
 *     gives constructive / destructive interference on flicks and reversals;
 *   - a sustained VELOCITY DRIVE, a steady lag proportional to speed, i.e. an
 *     accumulating measure of momentum while the parent keeps moving.
 *
 * Usage:
 *   const physics = createJigglePhysics({ bones: 3 });
 *   // every frame, feed the parent state and read back the offsets:
 *   const offsets = physics.update(dt, { yaw, pitch, body: {x,y,z} });
 *   // offsets is a Float32Array(bones*3): [x0,y0,z0, x1,y1,z1, ...]
 * ========================================================================== */

/** Metadata for the xlovecam jiggle physics reference standard. */
const JIGGLE_PHYSICS_META = {
  standard: "xlovecam-jiggle-physics",
  author: "xlovecam",
  repository: "https://github.com/xloveee/jiggle-physics",
  demo: "https://xloveee.github.io/jiggle-physics/"
};
function createJigglePhysics(opts) {
  opts = opts || {};
  const NBONE = opts.bones || 3;

  // Tunable parameters. The UI mutates these in place (sliders).
  // orbit = how hard orbit motion drives the jiggle (the "orbit drive" slider).
  const P = { k: 96, c: 2.8, m: 0.45, g: 2.2, orbit: 1.5 };

  // Driving / integration constants.
  const J_MAX = 0.4;                  // soft cap on bone displacement
  const BODY_GAIN = 8.0;              // object translation velocity -> parent velocity
  const VEL_TAU = 0.012;              // ~12 ms velocity smoothing; responsive, no jitter
  const KICK = 0.06;                  // impulse gain: parent Δv -> bone velocity
  const VDRIVE = 0.5;                 // sustained drive: steady momentum lag while moving
  const FIXED = 1 / 240;              // fixed physics timestep

  // Per-bone state + randomized character (frequency/damping/coupling/sag).
  const bones = [];
  const offsets = new Float32Array(NBONE * 3);
  for (let i = 0; i < NBONE; i++) {
    bones.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      mk: 1, mc: 1, cxx: 1, cxy: 0, cyx: 0, cyy: 1, gz: 0.3, gg: 0.8 });
  }

  // Smoothed velocity trackers (parent motion -> bone driving).
  let bodyVx = 0, bodyVy = 0, bodyVz = 0;
  let bodyPrevX = 0, bodyPrevY = 0, bodyPrevZ = 0;
  let yawVel = 0, pitchVel = 0, camYawPrev = 0, camPitchPrev = 0;
  let pvPrevX = 0, pvPrevY = 0, pvPrevZ = 0;   // last frame's parent velocity
  let pvX = 0, pvY = 0, pvZ = 0;               // current parent velocity (sustained driver)
  let acc = 0;                                 // fixed-timestep accumulator
  let primed = false;                          // suppress the first-frame velocity spike

  // Reseed each bone's character — gives a fresh combination of out-of-sync
  // jiggles so painted regions never wobble in lockstep.
  function reseed() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < NBONE; i++) {
      const b = bones[i];
      b.mk = rnd(0.45, 1.9);              // frequency multiplier (stiffness)
      b.mc = rnd(0.6, 1.5);               // damping multiplier
      b.cxx = rnd(0.7, 1.3); b.cxy = rnd(-0.6, 0.6);   // parent-vel -> bone plane
      b.cyx = rnd(-0.6, 0.6); b.cyy = rnd(0.7, 1.3);
      b.gz = rnd(0.15, 0.6);              // depth response
      b.gg = rnd(0.4, 1.25);             // gravity-sag scale
    }
  }
  reseed();

  function stepBodyVel(dt, body) {
    const rawVx = (body.x - bodyPrevX) / Math.max(dt, 1e-4);
    const rawVy = (body.y - bodyPrevY) / Math.max(dt, 1e-4);
    const rawVz = (body.z - bodyPrevZ) / Math.max(dt, 1e-4);
    bodyPrevX = body.x; bodyPrevY = body.y; bodyPrevZ = body.z;
    const blend = 1 - Math.exp(-dt / VEL_TAU);
    bodyVx += (rawVx - bodyVx) * blend;
    bodyVy += (rawVy - bodyVy) * blend;
    bodyVz += (rawVz - bodyVz) * blend;
  }

  function stepOrbitVel(dt, yaw, pitch) {
    const rawYaw = (yaw - camYawPrev) / Math.max(dt, 1e-4);
    const rawPitch = (pitch - camPitchPrev) / Math.max(dt, 1e-4);
    camYawPrev = yaw; camPitchPrev = pitch;
    const blend = 1 - Math.exp(-dt / VEL_TAU);
    yawVel += (rawYaw - yawVel) * blend;
    pitchVel += (rawPitch - pitchVel) * blend;
  }

  // Convert the change in parent velocity into a momentum impulse on each bone.
  // Orbit pitch is inverted vs object motion (camera-relative inertia: looking
  // down throws the mass up), while translating the object keeps its up/down.
  function applyParentImpulse() {
    const pvx = yawVel * P.orbit + bodyVx * BODY_GAIN;
    const pvy = -pitchVel * P.orbit + bodyVy * BODY_GAIN;
    const pvz = bodyVz * BODY_GAIN;
    const dpx = pvx - pvPrevX, dpy = pvy - pvPrevY, dpz = pvz - pvPrevZ;
    pvPrevX = pvx; pvPrevY = pvy; pvPrevZ = pvz;
    pvX = pvx; pvY = pvy; pvZ = pvz;
    for (let i = 0; i < NBONE; i++) {
      const J = bones[i];
      const ix = dpx * J.cxx + dpy * J.cxy;
      const iy = dpx * J.cyx + dpy * J.cyy;
      const g = P.m * KICK;
      J.vx -= g * ix;
      J.vy -= g * iy;
      J.vz -= g * (dpz + J.gz * iy * 0.5);
    }
  }

  function stepPhysics(h) {
    for (let i = 0; i < NBONE; i++) {
      const J = bones[i];
      const k = P.k * J.mk, c = P.c * J.mc;
      const dvx = pvX * J.cxx + pvY * J.cxy;
      const dvy = pvX * J.cyx + pvY * J.cyy;
      const fx = -k * J.x - c * J.vx - P.m * VDRIVE * dvx;
      const fy = -k * J.y - c * J.vy - P.g * J.gg - P.m * VDRIVE * dvy;
      const fz = -k * J.z - c * J.vz - P.m * VDRIVE * pvZ;
      J.vx += fx * h; J.vy += fy * h; J.vz += fz * h;
      J.x += J.vx * h; J.y += J.vy * h; J.z += J.vz * h;
      const len = Math.hypot(J.x, J.y, J.z);
      if (len > J_MAX) {                 // soft wall: clamp + bleed speed
        const s = J_MAX / len;
        J.x *= s; J.y *= s; J.z *= s;
        J.vx *= s; J.vy *= s; J.vz *= s;
      }
    }
  }

  function shake() {
    for (let i = 0; i < NBONE; i++) {
      const J = bones[i];
      J.vx += (Math.random() - 0.5) * 11;
      J.vy += (Math.random() - 0.5) * 11;
      J.vz += (Math.random() - 0.5) * 11;
    }
  }

  // Snap the velocity anchors to the current parent state so the next frame
  // measures zero motion (prevents a spike after init or a reset/teleport).
  function syncAnchors(yaw, pitch, body) {
    camYawPrev = yaw; camPitchPrev = pitch;
    bodyPrevX = body.x; bodyPrevY = body.y; bodyPrevZ = body.z;
  }

  function reset(input) {
    for (let i = 0; i < NBONE; i++) { const J = bones[i]; J.x = J.y = J.z = J.vx = J.vy = J.vz = 0; }
    bodyVx = bodyVy = bodyVz = 0; yawVel = pitchVel = 0;
    pvPrevX = pvPrevY = pvPrevZ = 0; pvX = pvY = pvZ = 0; acc = 0;
    if (input) syncAnchors(input.yaw, input.pitch, input.body);
  }

  // Advance the simulation by dt seconds given the current parent state.
  // Returns the packed Float32Array of bone offsets (also exposed as .offsets).
  function update(dt, input) {
    if (!primed) { syncAnchors(input.yaw, input.pitch, input.body); primed = true; }
    stepOrbitVel(dt, input.yaw, input.pitch);
    stepBodyVel(dt, input.body);
    applyParentImpulse();
    acc += dt;
    let sub = 0;
    while (acc >= FIXED && sub < 32) { stepPhysics(FIXED); acc -= FIXED; sub++; }
    for (let i = 0; i < NBONE; i++) {
      offsets[i * 3] = bones[i].x;
      offsets[i * 3 + 1] = bones[i].y;
      offsets[i * 3 + 2] = bones[i].z;
    }
    return offsets;
  }

  return { NBONE, params: P, offsets, meta: JIGGLE_PHYSICS_META, update, shake, reset, reseed };
}

if (typeof window !== "undefined") {
  window.createJigglePhysics = createJigglePhysics;
  window.JIGGLE_PHYSICS_META = JIGGLE_PHYSICS_META;
}
