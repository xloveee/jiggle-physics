# Jiggle Physics

A reference implementation of **weight-painted soft-body jiggle** — a small,
dependency-free standard you can drop into any game engine or renderer.

No build step. No package manager. Open `index.html` in a WebGL-capable browser.

## The technique

Two pieces:

1. **Per-region weights** in `[0, 1]` — painted on a UV weight map (one weight
   per vertex in a real engine).
2. **Damped spring bones** — each painted region follows one of several jiggle
   bones with randomized frequency/damping so regions wobble out of sync.

The entire deformation is one line:

```glsl
vertex += weight * boneJiggle;
```

In this demo (SDF ray-marcher), the equivalent is sampling the base shape at
`q - offset` where `offset = weight * boneOffset`.

## Files

```
jiggle/
├── index.html          # markup, styles, GLSL shader
├── jiggle-physics.js   # pure simulation (no DOM, no WebGL)
├── jiggle-app.js       # UI, weight painting, render loop
└── README.md
```

### `jiggle-physics.js`

`createJigglePhysics({ bones: 3 })` — the reusable engine.

- No DOM, no WebGL — drop into any game loop.
- Each bone is a damped spring driven by parent motion:
  - **Impulse** on parent acceleration (flicks, reversals).
  - **Velocity drive** — sustained lag while the parent keeps moving.
- Returns bone offsets each frame: `physics.update(dt, { yaw, pitch, body })`.

### `jiggle-app.js`

Demo glue: WebGL setup, orbit camera, UV weight painting, controls, render loop.
Feeds parent state to the engine and uploads bone offsets to the shader.

### `index.html`

Interactive reference scene with five test geometries (orb, capsule, torus, air
dancer, walker), weight heatmap, and physics sliders.

## Weight painting

Weights live in a **512×256 RGBA texture** (R/G/B = three jiggle bones). Each
geometry uses a Smart-UV-style projection (sphere / cylinder / torus) so paint
maps cleanly to the surface.

- **`P`** — paint mode (UV map panel appears)
- Paint in the **2D weight map**; **`+` / `−`** add or erase
- **Bone gain sliders** — scale painted regions after the fact (all / bone 0 / 1 / 2)
- **`W`** — show weight heatmap (blue = anchored, red = soft)
- **`G`** — cycle geometry · **`C`** clear · **`X`** random paint · **`Space`** shake

## Physics controls

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

## Integration sketch

```javascript
const physics = createJigglePhysics({ bones: 3 });

// each frame:
const offsets = physics.update(dt, {
  yaw, pitch,
  body: { x, y, z }   // parent object translation
});
// offsets: Float32Array [x0,y0,z0, x1,y1,z1, ...]

// per vertex in your mesh:
const w = sampleWeight(vertex.uv);          // from your weight map
const bone = sampleBoneIndex(vertex.uv);    // which spring drives this texel
vertex.position += w * boneOffset(bone);
```

## Running locally

```bash
# any static server, or open directly:
open index.html
```

With XAMPP: `http://localhost/RSC/jiggle/`

## License

Use freely. Attribution appreciated if you ship it in a project.
