"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — chains (extension, pure math).
 * https://github.com/xloveee/jiggle-physics
 *
 * A chain is N bones where link i hangs off link i-1 (tail, hair, antenna).
 * Each link still takes the exact closed-form step; the only change is its
 * input: parent acceleration = root acceleration + the acceleration of the
 * link above it (Δv/h from that link's step this frame). Sequential, exact per
 * link, no coupling forces.
 *
 *   const chain = createJiggleChain({ links: 6, seed: 1 });
 *   const offsets = chain.update(dt, rootAccel);
 *   // offsets: Float32Array(links*3), CUMULATIVE — link i's tip offset from
 *   // its rest position. chain.physics.bones[i].x is the local offset.
 * ========================================================================== */

function createJiggleChain(opts) {
  opts = opts || {};
  const N = opts.links || 4;
  const physics = createJigglePhysics({ bones: N, seed: opts.seed });
  const offsets = new Float32Array(N * 3);

  // Cumulative tip offsets from local link offsets (call after colliders).
  function pack() {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < N; i++) {
      const x = physics.bones[i].x;
      cx += x[0]; cy += x[1]; cz += x[2];
      offsets[i * 3] = cx; offsets[i * 3 + 1] = cy; offsets[i * 3 + 2] = cz;
    }
    return offsets;
  }

  function update(dt, root) {
    const h = Math.max(dt, 1e-4);
    let ax = root[0], ay = root[1], az = root[2];
    for (let i = 0; i < N; i++) {
      const v = physics.bones[i].v;
      const vx = v[0], vy = v[1], vz = v[2];
      physics.step(i, dt, ax, ay, az);
      ax += (v[0] - vx) / h; ay += (v[1] - vy) / h; az += (v[2] - vz) / h;
    }
    return pack();
  }

  return {
    N, physics, params: physics.params, offsets,
    get seed() { return physics.seed; },
    update, pack, shake: physics.shake, reset: physics.reset, reseed: physics.reseed
  };
}

if (typeof window !== "undefined") {
  window.createJiggleChain = createJiggleChain;
}
