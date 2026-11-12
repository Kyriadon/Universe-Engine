# Universe Engine

A browser-based simulator of the whole observable universe: every galaxy, star, planet, moon, black hole and exotic object humanity has discovered, flyable seamlessly from a planet's surface to the edge of the cosmos, with time you can run forward and backward.

One page. No routes, no accounts. It opens straight into the universe.

This README describes decisions and structure that are meant to last. Exact types, numbers and budgets live in the code, not here, so this file does not go stale when they change.

---

## 1. Locked decisions

- **Platform:** web, a single simulator page. Settings and bookmarks live in local browser storage only.
- **Stack:** TypeScript, Vite, WebGL2. A WebGPU backend can be added later behind the same renderer interface. Heavy work runs in Web Workers; WASM is added only when a specific kernel needs it.
- **Why web:** every change can be built, type-checked and render-checked headlessly; JavaScript gives float64 math for free; it runs on integrated graphics with zero install.
- **Performance target:** 60 FPS on the developer's laptop (Intel Core i5, integrated graphics). Hard floor: 55 FPS at the 95th percentile on the Medium quality tier. Dynamic resolution scaling protects the floor.
- **Realism first:** real data wherever it exists, physically grounded models everywhere else.
- **Determinism:** anything procedural is a pure function of a seed and a cell ID. Nothing is stored that can be regenerated.

## 2. Repository layout

Everything below excluding `graphics/`, `geometry/` and `physics/` lives in `packages/core/src/`.

```
packages/core/src/
  index.ts                 loads the page
  coords.ts                hierarchical coordinates + floating origin (section 3)

  information/             what exists: one file per object, grouped by scale
    lanikea/                 supercluster
      local-group/             cluster
        milkyway/                galaxy
          milkyway.ts
          solar/                   system
            solar.ts
        andromeda/
          andromeda.ts
    ...                      rogue planets, stars, systems, black holes, etc.

graphics/                how it looks
  renderer.ts              runs and renders whatever the user launches (e.g. npm run solar)
  shaders.ts               shaders, ray-tracing look, atmosphere, auroras, gases
  gl.ts                    GPU and CPU load, GUI, user processes and controls

geometry/                what it is shaped like
  terrain.ts               terrain for planets, stars, moons, anything that asks for it
  geometry.ts              greyscale look, structure of black holes, stars and planets, realistic scaling

physics/                 how it behaves
  physics.ts               physics, tearing, collisions, everything physical
  (more files as needed)
```

The `information/` tree mirrors the universe: supercluster, then cluster, then galaxy, then system. Objects that belong to no system (rogue planets, interstellar stars, isolated black holes) get their own files at the level where they live.

## 3. Coordinates (`coords.ts`)

The universe is far too large for one float. Every position lives in exactly one scale tier and is stored as **integer sector indices** (which grid cell of that tier) plus a **float64 local offset in meters** from that cell's corner. The GPU never sees these values: `deltaInto()` writes camera-relative numbers straight into a Float32Array, so precision stays high at every scale.

| Tier | Cell edge | Cells per edge of the next-coarser cell | Exact out to (from origin) |
| --- | --- | --- | --- |
| Universe | 1e26 m | n/a | whole observable universe |
| Supercluster | 1e24 m | 100 | whole observable universe |
| Galaxy | 1e21 m | 1,000 | whole observable universe |
| System | 1e15 m | 1,000,000 | whole observable universe |
| Planet | 1e9 m | 1,000,000 | about 0.95 billion light-years |
| Surface | 1e4 m | 100,000 | about 9,500 light-years |

Rules that follow from the math (sector indices are float64 integers, exact only below 2^53):

- `makePos` throws a `RangeError` rather than store a sector index that cannot be exact.
- `toTier` going finer stops at the finest tier that is still exact, so the result can be coarser than requested. Always read `result.tier`.
- `deltaInto` computes the camera-relative vector. Same-tier calls do not allocate; mixed tiers do. If one side is too far out to be exact at the finer tier, both meet at the finest tier that is exact for both.
- A camera far from the origin stays at the Planet tier, which still resolves about 1e-7 m.

All positions in `information/` files are expressed with the types from `coords.ts`.

## 4. How the pieces fit

1. **`information/`** declares an object completely: identity, position, bodies, surface data (latitude, longitude), textures, and its lifecycle. `solar.ts` tells the engine everything about the Solar System: planets, gas giants, rocky bodies, coordinates, textures. Every other file follows the same idea for its object.
2. **`geometry/`** turns that description into shapes at the correct physical scale. Any information file can call `terrain.ts` when its bodies need terrain.
3. **`physics/`** advances state: orbits, collisions, tearing, tides, relativity.
4. **`graphics/`** draws it: `renderer.ts` runs the chosen target, `shaders.ts` gives it the look, `gl.ts` manages the GPU and CPU budget and the controls.
5. **`index.ts`** loads the page and starts the renderer.

Run a target with its npm script, for example `npm run solar` for the Solar System.

## 5. Rendering principles

- Render layers, far to near: background and CMB, large-scale structure, galaxies, stars and clusters, nebulae, system bodies, planets and terrain, atmospheres and clouds, effects, post-processing.
- Every layer has a level-of-detail scheme and a hard time budget. Budgets are enforced in code and verified on the target laptop.
- HDR with physically based exposure, color-correct blackbody stars, bloom, motion blur (including star trails), temporal upscaling.
- Reversed-Z and logarithmic depth. Camera-relative float32 only on the GPU.
- Quality tiers (Low, Medium, High, Ultra) plus dynamic resolution scaling.

## 6. Physics principles

- **Physics level of detail.** Simulate only what the camera cares about. Use closed-form or tabulated models everywhere else, and local numerical simulation (in Workers) only where interaction matters and only in bounded space and time.
- **Time is a function, not an integration.** Every object has a deterministic, seekable lifecycle f(object, t) from birth to death, so time can run forward, backward and at extreme speed. Where objects interact (mergers, impacts), a local simulation is seeded from the lifecycle state at that moment.
- **Honest models.** Each model is validated against published values and test cases. Theoretical objects are labeled as such.

## 7. Scope: what "complete" means

The engine is breadth-complete when every category below exists, runs on a physically grounded baseline model, is reachable seamlessly from the one page, and can be time-scrubbed. Accuracy and detail keep deepening afterward.

- **Structure:** cosmic web, superclusters, clusters, every galaxy type, star clusters, nebulae, interstellar and intergalactic medium, the CMB.
- **Objects:** all stellar types, planetary systems, moons, rings, asteroids, comets, rogue bodies.
- **Exotics:** black holes of every class, neutron stars, pulsars, magnetars, white dwarfs, quasars, blazars, plus a flagged-theoretical tier (gravastars, boson stars, quasi-stars, quark stars, wormholes, white holes).
- **Events:** supernovae, novae, kilonovae, GRBs, FRBs, tidal disruption events, planetary nebulae, flares and CMEs, mergers, impacts, eruptions, auroras, eclipses, transits.
- **Surfaces:** terrain, oceans, ice, atmospheres, clouds, weather, correct skies, rings, shadows, gas giant cloud tops, star surfaces.
- **Navigation:** free flight, orbit, go-to, land, walk, telescope zoom, speeds from walking pace to many times light speed, autopilot.
- **Time:** real time to billions of years per second, both directions, with a birth-to-death timeline for every object.
- **Tools:** search, info panel, HR diagram, measurement, screenshots, video capture, bookmarks, settings, scripting console.

Out of scope until explicitly pulled in: life and artificial structures, spacecraft, VR, audio, mods.

## 8. Data and licensing

- **Real first.** Use actual data where it exists (JPL and NASA for the Solar System and planetary maps, published star, exoplanet, galaxy, quasar and exotic-object catalogs). Fill gaps procedurally from physical models.
- **Every object carries one label:** REAL, DERIVED, PROCEDURAL or HYPOTHETICAL.
- **Textures and data must be free to use.** Every source, texture and license is credited in a `DATA_SOURCES.md` attribution file at the repo root.
- **Large data files stay out of Git.**
- **Code license:** MIT or Apache-2.0, chosen before the first public release. No code or assets from Space Engine.

## 9. Working rules

- Complete files only, never diffs.
- No unused code and no silent assumptions. API shapes and data formats are confirmed before code is written against them.
- Every change is validated by a real build, a typecheck and tests, plus a headless render check, before it is delivered.
- A headless render proves the scene draws. Real frame-rate numbers come only from the target laptop, because the build sandbox has no GPU.
- Anything outside this document is parked, not built.

## 10. Known limits

- Browser memory is capped (roughly 2-4 GB per tab), so data is streamed and cached with eviction.
- WebGL2 has no compute shaders; heavy kernels go to Workers or WASM until a WebGPU backend exists.
- Positions beyond the exactness range of a tier (section 3) are held at a coarser tier by design.
