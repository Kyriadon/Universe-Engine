# Universe Engine: Master Plan v1

*Working title · browser-based, Space Engine-class simulator of the observable universe · November 2026*

## 1. Locked decisions

- **Platform: web, one page.** One simulator page. No routes, no shareable URLs, no landing page, no accounts. It opens straight into the universe. Bookmarks and settings live in local browser storage only.
- **Stack:** TypeScript + Vite, a WebGL2 renderer (a WebGPU backend is added later behind the same interface), Web Workers for generation, and Rust compiled to WASM for heavy simulation kernels.
- **Why web beats native here:** every iteration can be built, tested, and render-checked headlessly; JavaScript gives float64 math for free; it runs on integrated graphics with zero install. The price is a performance ceiling roughly 20-30% below native, a browser memory cap (about 2-4 GB per tab), and no compute shaders until WebGPU.
- **Performance target:** at least 55 FPS (95th percentile) on the owner's laptop (Intel Core i5, integrated graphics) at the Medium quality tier.
- **Optional later:** a Tauri desktop wrapper around the same code. Not part of v1.

## 2. What six months means

Space Engine is more than a decade of work, and no simulator contains literally all of physics. So **v1.0 is defined as breadth-complete**: every category of object and every class of event exists, runs on a physically grounded baseline model, is reachable seamlessly from one page, and can be time-scrubbed. Accuracy, detail, and polish keep deepening for years afterward.

**v1.0 acceptance tests**

1. Start on Earth's surface, fly to orbit, then to the Moon, Mars, and the outer Solar System with no loading screens.
2. Continue to another star, another galaxy, and a quasar billions of light-years away in one unbroken flight.
3. Land on a procedural exoplanet and walk its surface under the correct sky, sun, and moons.
4. Use time acceleration to watch a star form, live out its life, and die as a supernova, then inspect the remnant.
5. Fall toward a black hole and see lensing, the accretion disk, and the photon ring.
6. Scrub time from the Big Bang to the far future.
7. Hold 55+ FPS on the target laptop through all of the above.

## 3. Feature checklist (Space Engine parity and beyond)

- **Navigation:** free flight, orbit-around, go-to, land, surface walk and fly, FOV and telescope zoom, speeds from walking pace to many times light speed, autopilot travel-to, relativistic mode toggle.
- **Universe:** cosmic web (filaments, voids, clusters, superclusters), every galaxy type, star clusters, nebulae, all stellar types, planetary systems, moons, rings, asteroids, comets, interstellar and intergalactic medium, the CMB.
- **Exotics:** black holes (stellar, intermediate, supermassive, primordial), neutron stars, pulsars, magnetars, white dwarfs, quasars, blazars, AGN, plus a flagged-theoretical tier: gravastars, boson stars, quasi-stars (black hole stars), quark stars, wormholes, white holes.
- **Events:** supernovae (all types), novae, kilonovae, GRBs, FRBs, tidal disruption events, planetary nebulae, stellar flares and CMEs, galaxy mergers, planetary impacts, volcanic eruptions, auroras, eclipses, transits, occultations.
- **Surfaces:** terrain, oceans, ice, atmosphere, clouds, weather, a correct sky with stars, planets, and moons, rings, shadows, gas giant cloud tops, and star surfaces.
- **Time:** real time up to billions of years per second, forward and backward. Every object has a birth-to-death timeline.
- **Tools:** search by name or catalog ID, info panel, HR diagram, measurement tool, screenshots, video capture, local bookmarks, settings and quality tiers, scripting console.
- **Visuals:** HDR, physically based exposure, bloom, lens flare, motion blur and star trails, temporal upscaling, color-correct blackbody stars.

## 4. Architecture

**Coordinates.** Hierarchical: integer sector IDs plus float64 local offsets per scale tier (universe, supercluster, galaxy, system, planet, surface). The GPU gets camera-relative float32, with reversed-Z and logarithmic depth. Every cell's contents are a deterministic function of (universe seed, cell ID), so nothing is stored that can be regenerated.

**Render layers, far to near:** CMB and background, cosmic web impostors, galaxies, stars and clusters, nebulae, system bodies, planets and terrain, atmospheres and clouds, effects, post-processing. Each layer has LOD and a hard budget.

**Streaming.** Catalog data is compiled offline into binary octree tiles, streamed by distance, and cached in IndexedDB. Generation runs in Web Workers on a time-sliced budget and never blocks a frame.

**Frame budget (16.6 ms)**

| Stage | Budget | Technique |
| --- | --- | --- |
| Stars | 2.5 ms | Instanced point sprites, HDR, magnitude-correct flux |
| Galaxies and nebulae | 2 ms | Impostors far, point clouds near, minimal volumetrics |
| Planets | 4 ms | Cube-sphere CDLOD quadtree, GPU height tiles, tile cache |
| Atmosphere and clouds | 1.5 ms | Precomputed scattering LUTs, cloud shells, low-res temporal volumetrics |
| Post | 3 ms | Half-res bloom, tonemap, auto-exposure, motion blur, upscaler |
| Exotics | 1 ms | Lensing lookup tables, analytic accretion disks |
| CPU and JS | 4 ms or less | Workers, WASM, time-sliced generation |

**Quality tiers:** Low, Medium (target), High, Ultra, plus dynamic resolution scaling (0.5-1.0x internal) with temporal upscaling to hold the frame rate.

**Motion blur:** a velocity buffer from depth reprojection (8-12 taps), plus star sprites stretched along screen-space velocity for trails.

## 5. Physics: what complete means

**Principle: physics LOD.** Simulate only what the camera cares about, and evaluate closed-form or tabulated models everywhere else. Three tiers: **T1** analytic, **T2** semi-analytic or tabulated, **T3** local numerical simulation (WASM in Workers, bounded in space and time).

| Domain | v1.0 model | Deeper later |
| --- | --- | --- |
| Gravity and orbits | Kepler on-rails, symplectic N-body for local and perturbed bodies | System-wide perturbations, resonance chains |
| Special relativity | Aberration, Doppler shift, time dilation, length contraction | None needed |
| General relativity | Schwarzschild and Kerr lensing LUTs, gravitational redshift, photon rings, frame-dragging approximation | Full geodesic ray tracing (WebGPU) |
| Gravitational waves | Post-Newtonian chirp waveform, spacetime ripple shader | Numerical-relativity-fitted waveforms |
| Stellar evolution | MIST/PARSEC track tables, all stages | Binary evolution, mass transfer, common envelope |
| Stellar surfaces | Granulation, spots, limb darkening, prominences, flares, CMEs, activity cycles | MHD-informed dynamics |
| Supernovae (Ia, II-P/L, IIb, Ib/c, electron-capture, pair-instability) | Light curves (Ni-56 decay, Arnett-type), shock breakout, expanding ejecta, Sedov-Taylor remnant growth | Spectral evolution, 3D instabilities |
| Mergers, kilonovae, GRBs | Local particle sim, analytic light curves, jet beaming, r-process color evolution | Better ejecta and jet models |
| Accretion and jets | Shakura-Sunyaev disk emission with Doppler beaming, jet shaders, TDE debris streams | GRMHD-informed structure |
| Pulsars and magnetars | Dipole field lines, lighthouse beams, spin-down, glitches, flares | Magnetosphere detail |
| Planet formation | Disk model: frost line, planetesimal accretion, migration, giant impacts | N-body formation runs |
| Geology | Differentiation, heat budget, plate tectonics (lite), volcanism, impact cratering | Mantle convection |
| Atmospheres and weather | Rayleigh/Mie scattering, greenhouse energy balance, Coriolis-banded circulation, clouds, storms, aurora, lightning | GCM-lite |
| Oceans and tides | Gerstner waves, tidal forcing from moons and stars, ice caps, sea level | Currents |
| Tides, Roche, rings | Tidal locking and evolution, Roche limit, ring gaps and shepherd moons | Ring dynamics sim |
| Small bodies | Asteroid and comet orbits, outgassing tails, meteor showers, impacts | Collision evolution |
| Radiation and spectra | Blackbody to sRGB, magnitudes, auto-exposure, extinction and reddening, nebular emission lines | Full spectral rendering |
| Interstellar medium | HII regions, SNRs, planetary nebulae, dark clouds, triggered star formation | Turbulence sim |
| Galaxy dynamics | Rotation curves, density waves, bars, tidal tails, local particle mergers, AGN feedback | Full N-body halos |
| Cosmology | Friedmann LCDM expansion, redshift, structure growth, CMB, Big Bang epochs, alternative futures (heat death, Big Rip toggle) | Alternative cosmologies |
| Exotic and hypothetical | Gravastar, boson star, quasi-star, quark star, wormhole, white hole (flagged theoretical) | New proposals as published |

## 6. The time machine: birth and death of anything

**Key design rule:** scrubbing time forward and backward requires object state to be a **function of time**, not a forward integration. Every object has a lifecycle model f(object, t) that is deterministic and seekable. Where interaction matters (mergers, impacts), a local T3 simulation is seeded from the lifecycle state at time t.

| Class | Birth | Life | Death or fate |
| --- | --- | --- | --- |
| Star | Molecular cloud collapse, protostar, disk | Pre-main sequence, main sequence, subgiant, giant, AGB, Wolf-Rayet | White dwarf plus planetary nebula, or supernova leaving a neutron star or black hole |
| Planet | Disk accretion, magma ocean | Differentiation, cooling, climate evolution | Engulfed, evaporated, ejected, tidally destroyed |
| Moon | Giant impact, co-accretion, or capture | Tidal evolution | Roche breakup or impact |
| Galaxy | Protogalaxy, disk settling | Mergers, star formation, quenching | Fossil elliptical |
| Black hole | Stellar collapse, direct collapse, primordial | Accretion growth, mergers | Hawking evaporation (accelerated visualization) |
| Nebula | Cloud, ejecta, or outflow | Expansion, enrichment, triggered star formation | Dispersal |
| Universe | Big Bang | Inflation, nucleosynthesis, recombination, dark ages, cosmic dawn, reionization, today | Heat death, with a Big Rip option as a selectable cosmology |

**Controls:** pause, real time, speeds up to about 10 billion years per second, reverse, jump to the next event (for example the next supernova in this system), and a cosmic epoch bar.

## 7. Surfaces

- **Rocky planets and moons:** cube-sphere CDLOD terrain down to sub-meter detail from procedural noise, biomes from climate, oceans, ice, craters, volcanoes, rivers, seasonal change from axial tilt, correct sky with the local star, moons, and planets, eclipses, rings and ring shadows, aurora, lightning, and storms.
- **Gas and ice giants:** flow-warped band shaders, storms and vortices, a descent through cloud decks, lightning, and auroras.
- **Star surfaces:** granulation cells scaled by stellar type, limb darkening, sunspots, prominences along magnetic arcs, flares and CMEs, and giant-star convection cells.
- **Compact objects:** approach views for neutron stars, white dwarfs, and black holes, including the photon ring and accretion disk.
- **Inside nebulae and clusters:** volumetric dust and gas, embedded stars, and pillars.
- **Life and artificial structures:** out of scope for v1.0.

## 8. Universe data and generation

- **Real data layers:** Solar System (JPL SPICE and Horizons, NASA/USGS planetary maps), stars (Hipparcos, Tycho-2, HYG, a Gaia subset, 3D dust maps), exoplanets (NASA Exoplanet Archive), small bodies (MPC), nebulae and clusters (OpenNGC, Messier), galaxies and large-scale structure (2MRS, 6dF, SDSS, DESI DR1, Cosmicflows-4), quasars (Milliquas), exotics (ATNF pulsars, McGill magnetars, Gaia black holes, LIGO GWTC, Green's SNR catalog, CHIME FRBs, Fermi GRBs), and the CMB (Planck).
- **Procedural fill:** cosmic web from a Gaussian random field with the LCDM power spectrum, halos from the mass function, galaxies by halo occupation, stars by IMF and stellar population synthesis, planets from a disk model, surfaces from noise plus tectonics, erosion, and climate.
- **Tagging:** every object is labeled REAL, DERIVED, PROCEDURAL, or HYPOTHETICAL.
- **Pipeline:** Python scripts fetch catalogs and compile binary octree tiles. A starter set (about 100-200 MB) covers the core; larger tiers are optional. Data files stay out of Git; a DATA\_SOURCES file tracks attribution and licenses.

## 9. Six-month roadmap (26 weeks, breadth first)

| Milestone | Weeks | Deliverables | Exit criteria |
| --- | --- | --- | --- |
| **M1 Foundation and stars** | 1-4 | Monorepo, CI, coordinate system, floating origin, camera and flight modes, perf HUD, dynamic resolution, star renderer (HYG, Hipparcos), HDR, bloom, auto-exposure, motion blur, search and info panel | 120k stars at 55+ FPS; fly freely among them |
| **M2 Solar System and surfaces** | 5-9 | JPL orbits, CDLOD terrain, atmospheres, rings, moons, NASA textures, seamless orbit-to-surface, basic time control, eclipses | Earth orbit to Moon surface walk-around, no loading screens |
| **M3 Galaxies and star systems** | 10-13 | Milky Way (Gaia subset plus procedural), procedural stars and systems, exoplanets, nebulae, clusters, star surface view, all galaxy types | Seamless planet-to-galaxy-to-neighbor-galaxy flight |
| **M4 Cosmic web and observable universe** | 14-16 | Large-scale structure, clusters and superclusters, quasars, CMB sphere, redshift and lookback time | Fly from the Local Group to a quasar at the observable edge |
| **M5 Exotics, events, time machine** | 17-22 | Black holes with lensing, neutron stars, pulsars, magnetars, supernova suite, kilonovae, GRBs, TDEs, remnants, hypothetical tier, lifecycle engine for all classes, time scrubbing, local N-body sims, tides, weather, tectonics-lite | Acceptance tests 4, 5, and 6 pass |
| **M6 Performance, tools, QA** | 23-26 | Optimization passes, quality tiers, HUD tools (HR diagram, measurement), screenshots and video capture, bookmarks, scripting console, bug bash | All 7 acceptance tests pass on the target laptop |

Running in parallel every month: the data pipeline, automated tests, and perf regression checks.

## 10. After v1.0 (years)

- Full geodesic ray tracing and a native WebGPU renderer.
- Real hydrodynamic and MHD-informed supernovae, mergers, and accretion.
- Deeper stellar evolution (binaries, mass transfer), full N-body galaxy halos, and finer geophysics and climate.
- Gaia DR4 and larger real-data tiers, plus new catalogs as they are published.
- Vegetation, procedural life, and artificial structures; spacecraft models; VR via WebXR; audio (ambient and pulsar sonification); mods and add-on catalogs.
- A Tauri desktop build and an optional native Rust/wgpu port.

## 11. Risks

- **Scope:** mitigated by breadth-first milestones; anything not in this plan goes to a backlog file.
- **Integrated GPU performance:** mitigated by frame budgets, dynamic resolution, and perf regression checks every milestone.
- **Browser memory cap:** mitigated by streaming, tile caches with eviction, and compact binary formats.
- **Physics correctness:** mitigated by validating models against published values and test cases.
- **Data size and licensing:** mitigated by tiered downloads and a tracked attribution file.
- **Throughput:** six months is only realistic with weekly hardware test loops. The build sandbox has no GPU, so real FPS numbers must come from the target laptop.

## 12. Repo layout and working rules

```
apps/web            the single simulator page
packages/core       coordinates, math, time
packages/render     WebGL2 renderer, shaders, post
packages/universe   procedural generators
packages/physics    orbits, relativity, astrophysics, lifecycles
packages/data       tile loaders and streaming
tools/pipeline      Python catalog-to-tile compiler
docs/               roadmap, data sources, licenses
```

- Complete files only, never diffs.
- No unused code and no silent assumptions; API shapes and data formats are confirmed before code is written against them.
- Every delivery is validated by a real build, typecheck, tests, and a headless render check.
- Code license MIT or Apache-2.0; no code or assets from Space Engine.
