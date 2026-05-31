# xlovecam Jiggle Physics

<p align="center">
  <img src="asset/jiggle-physics-demo.gif" alt="Jiggle physics demo" width="100%">
</p>

**A reference standard for real-time jiggle physics** by **xlovecam** — how to
paint soft regions, drive damped spring bones, and deform meshes consistently
across engines.

> Not ragdoll. Not cloth. Not full soft-body FEM.  
> Paint weight on a UV map, drive randomized spring bones from parent motion,  
> one rule: `vertex += weight * boneJiggle`.

**[Live demo](https://xloveee.github.io/jiggle-physics/)** · **Author: [xlovecam](https://github.com/xloveee)**

No build step. Open `index.html` in any WebGL-capable browser.

---

## Also known as

Spring bones · jiggle bones · soft-body secondary motion · weight-painted physics ·
vertex weight jiggle · Blender-style flesh bounce · mesh wobble · damped spring
deformation · parent-velocity lag · orbit-driven bounce

---

## The standard

Two pieces, one contract:

| Piece | What it is |
| --- | --- |
| **Weight map** | Per-region softness in `[0, 1]`, painted on a UV texture (one weight per vertex in a real engine). |
| **Jiggle bones** | A small set of damped springs; each painted region follows one bone. Randomized frequency/damping so regions wobble **out of sync**. |

The entire deformation:

```glsl
vertex += weight * boneJiggle;
```

In this demo (SDF ray-marcher), the equivalent samples the base shape at
`q - offset` where `offset = weight * boneOffset`, with asymmetric squash &
stretch along the motion vector (trailing bulge, leading flatten).

---

## Architecture

```
jiggle/
├── index.html          # markup, styles, GLSL shader
├── jiggle-physics.js   # pure simulation (no DOM, no WebGL)
├── jiggle-app.js       # UI, UV weight painting, render loop
└── asset/              # demo GIF
```

### `jiggle-physics.js` — simulation engine

`createJigglePhysics({ bones: 3 })` — drop into any game loop.

- **No DOM, no WebGL** — renderer-agnostic.
- Each bone is a damped spring driven two ways:
  - **Impulse** on parent acceleration (flicks, reversals, constructive interference).
  - **Velocity drive** — sustained lag while the parent keeps moving.
- Per-bone character: randomized stiffness, damping, coupling, and gravity sag.
- Returns bone offsets each frame:

```javascript
const offsets = physics.update(dt, { yaw, pitch, body: { x, y, z } });
// Float32Array [x0,y0,z0, x1,y1,z1, ...]
```

### `jiggle-app.js` — the demo

WebGL setup, orbit camera, UV weight painting, controls, render loop. Feeds
parent state to the engine and uploads bone offsets + weight textures to the shader.

### `index.html` — the reference scene

Five test geometries with demo presets, weight heatmap, physics sliders, and a
2D UV paint window.

---

## Weight painting

Weights live in a **512×256 RGBA texture** (R / G / B = three jiggle bones).
Each geometry uses a **Smart-UV-style projection** so paint maps cleanly to the
surface:

| Geometry | Projection |
| --- | --- |
| Orb | Sphere (equirectangular) |
| Capsule | Cylinder along Y |
| Torus | Major ring U + tube V |
| Air dancer | Cylinder along swaying centreline |
| Walker | Cylinder, seam at back |

Paint in the **2D UV map panel** (not on the 3D viewport). One texture lookup
per sample — no brush cap, no per-step cost scaling.

### Controls

| Input | Action |
| --- | --- |
| **`P`** | Paint mode — UV map panel appears |
| Paint in UV window | Add weight (Blender-style flow build-up) |
| **`+` / `−`** | Add / erase brush |
| **`W`** | Toggle weight heatmap (blue = anchored → red = soft) |
| **`G`** | Cycle geometry |
| **`C`** | Clear weights |
| **`X`** | Random paint |
| **`Space`** | Shake |
| **`R`** | Reset camera |
| Drag | Orbit (drives jiggle) |
| Shift-drag | Move object (also drives jiggle) |
| Wheel | Zoom |

### Region strength sliders

Below the UV map — scale painted regions **after the fact** without re-painting:

- **all** — master gain on every painted region
- **bone 0 / 1 / 2** — per-channel gain (each stroke assigns a bone in rotation)

### Demo presets

Each geometry loads a preset weight map on switch (`G`) that showcases the
standard with multiple out-of-sync bones:

- **Orb** — heavy sagging bottom + softer equatorial band
- **Capsule** — heavy hanging bottom cap + mid belly
- **Torus** — three lobes evenly spaced on the outer rim
- **Air dancer** — head-heavy stacked rings, feet anchored
- **Walker** — soft bust, glutes, groin

---

## Physics sliders

| Slider | Parameter |
| --- | --- |
| stiffness | spring constant |
| damping | velocity damping |
| mass | inertia |
| gravity | sag under gravity |
| orbit drive | how hard camera orbit drives jiggle |
| brush size | UV paint radius |
| brush weight | paint target strength |
| force radius | jiggle spread from painted regions |

---

## Integration

```javascript
const physics = createJigglePhysics({ bones: 3 });

// each frame:
const offsets = physics.update(dt, {
  yaw, pitch,
  body: { x, y, z }   // parent object translation
});

// per vertex in your mesh:
const w = sampleWeight(vertex.uv);       // from your weight map (0..1)
const bone = sampleBoneIndex(vertex.uv); // which spring drives this texel
vertex.position += w * boneOffset(bone);
```

The weight map and bone index map are the portable assets. The physics engine
is the portable simulation. Any renderer that can multiply and add vectors can
implement the standard.

---

## Running locally

```bash
open index.html
# or serve statically:
python3 -m http.server 8080
```

## License

Use freely. Please attribute **xlovecam** and link to
[github.com/xloveee/jiggle-physics](https://github.com/xloveee/jiggle-physics)
if you ship this standard in a project.
