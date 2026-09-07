"use strict";

/* ============================================================================
 * xlovecam Jiggle Physics — colliders (extension, pure math).
 * https://github.com/xloveee/jiggle-physics
 *
 * Post-step constraint projection. The exact spring step runs unconstrained;
 * then each bone is pushed out of any collider along the surface normal and
 * the velocity component into the surface is removed (restitution optional).
 * Exact between contacts, a discrete event at contact — the same scheme every
 * production spring-bone system uses. Point-vs-surface only: a bone is a point
 * mass standing in for a region, so this models "region hits a surface", not
 * mesh-vs-mesh self-collision.
 *
 * A bone's world position is base + offset. Colliders are world-space; `limit`
 * confines the offset itself to a sphere around its rest point.
 *
 *   const col = createJiggleColliders({ limit: 0.4, restitution: 0 });
 *   const floor = col.plane(0, 1, 0, -1);        // n·p >= d  (mutable {nx,ny,nz,d})
 *   const ball  = col.sphere(1, 0, 0, 0.5);      // keep out  (mutable {cx,cy,cz,r})
 *   col.resolveAll(physics, bx, by, bz);         // shared rest point
 *   col.resolve(bone.x, bone.v, bx, by, bz);     // one bone, its own rest point
 * ========================================================================== */

function createJiggleColliders(opts) {
  opts = opts || {};
  const limit = opts.limit || 0;
  const bounce = 1 + (opts.restitution || 0);
  const list = [];
  const p = [0, 0, 0], n = [0, 0, 0];

  // Move the bone out along n by depth; remove the velocity component into the surface.
  function push(x, v, depth) {
    x[0] += n[0] * depth; x[1] += n[1] * depth; x[2] += n[2] * depth;
    const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    if (vn < 0) { v[0] -= n[0] * vn * bounce; v[1] -= n[1] * vn * bounce; v[2] -= n[2] * vn * bounce; }
  }

  // Keep the world point p outside the sphere (c, r).
  function pushOut(x, v, cx, cy, cz, r) {
    const qx = p[0] - cx, qy = p[1] - cy, qz = p[2] - cz;
    const len = Math.hypot(qx, qy, qz);
    if (len >= r) return;
    if (len > 1e-9) { n[0] = qx / len; n[1] = qy / len; n[2] = qz / len; }
    else { n[0] = 0; n[1] = 1; n[2] = 0; }
    push(x, v, r - len);
  }

  function plane(nx, ny, nz, d) {
    const l = Math.hypot(nx, ny, nz) || 1;
    const c = { nx: nx / l, ny: ny / l, nz: nz / l, d };
    list.push(function (x, v) {
      const dist = p[0] * c.nx + p[1] * c.ny + p[2] * c.nz - c.d;
      if (dist >= 0) return;
      n[0] = c.nx; n[1] = c.ny; n[2] = c.nz;
      push(x, v, -dist);
    });
    return c;
  }

  function sphere(cx, cy, cz, r) {
    const c = { cx, cy, cz, r };
    list.push((x, v) => pushOut(x, v, c.cx, c.cy, c.cz, c.r));
    return c;
  }

  function capsule(ax, ay, az, bx, by, bz, r) {
    const c = { ax, ay, az, bx, by, bz, r };
    list.push(function (x, v) {
      const dx = c.bx - c.ax, dy = c.by - c.ay, dz = c.bz - c.az;
      const dd = dx * dx + dy * dy + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - c.ax) * dx + (p[1] - c.ay) * dy + (p[2] - c.az) * dz) / dd));
      pushOut(x, v, c.ax + dx * t, c.ay + dy * t, c.az + dz * t, c.r);
    });
    return c;
  }

  // Resolve one bone: x/v are its offset and velocity, (bx,by,bz) the rest
  // point the offset is measured from.
  function resolve(x, v, bx, by, bz) {
    for (let i = 0; i < list.length; i++) {
      p[0] = bx + x[0]; p[1] = by + x[1]; p[2] = bz + x[2];
      list[i](x, v);
    }
    if (limit > 0) {
      const len = Math.hypot(x[0], x[1], x[2]);
      if (len > limit) {
        n[0] = -x[0] / len; n[1] = -x[1] / len; n[2] = -x[2] / len;
        push(x, v, len - limit);
      }
    }
  }

  function resolveAll(physics, bx, by, bz) {
    const bones = physics.bones;
    for (let i = 0; i < bones.length; i++) resolve(bones[i].x, bones[i].v, bx, by, bz);
    return physics.pack();
  }

  return { plane, sphere, capsule, resolve, resolveAll };
}

if (typeof window !== "undefined") {
  window.createJiggleColliders = createJiggleColliders;
}
