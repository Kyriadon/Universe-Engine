/**
 * packages/core/src/coords.ts
 *
 * Hierarchical coordinates + floating origin (Master Plan section 4).
 *
 * A position lives in ONE scale tier and is stored as:
 *   - integer sector indices (which grid cell of that tier), and
 *   - a float64 local offset in meters from that cell's min corner.
 *
 * The local offset never exceeds one cell, and cells shrink as tiers get finer,
 * so precision stays high at every scale. The GPU never sees these values:
 * deltaInto() writes camera-relative numbers straight into a Float32Array.
 */

export type Vec3 = readonly [number, number, number];

export const Tier = {
  Universe: 0,
  Supercluster: 1,
  Galaxy: 2,
  System: 3,
  Planet: 4,
  Surface: 5,
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/** Cells of the next-finer tier along one edge of a cell, for Universe..Planet. */
const SPLIT: readonly number[] = [100, 1_000, 1_000_000, 1_000_000, 100_000];
const split = (t: number): number => SPLIT[t] as number;

/**
 * Cell edge length in meters per tier, built from the finest tier upward so the
 * integer SPLIT ratios stay the single source of truth.
 *   Surface 1e4 m, Planet 1e9 m, System 1e15 m,
 *   Galaxy 1e21 m, Supercluster 1e24 m, Universe 1e26 m
 */
export const CELL_SIZE_M: readonly number[] = (() => {
  const sizes = new Array<number>(Tier.Surface + 1);
  let size = 1e4;
  for (let t: number = Tier.Surface; t >= Tier.Universe; t--) {
    sizes[t] = size;
    if (t > Tier.Universe) size *= split(t - 1);
  }
  return sizes;
})();
const cell = (t: number): number => CELL_SIZE_M[t] as number;

export interface WorldPos {
  readonly tier: Tier;
  /** Integer cell indices at this tier. */
  readonly sector: Vec3;
  /** Meters from the cell's min corner, each axis in [0, CELL_SIZE_M[tier]). */
  readonly local: Vec3;
}

/** Carry a local offset into the sector index so local lands in [0, cell). */
function wrap(sector: number, local: number, c: number): [number, number] {
  let k = Math.floor(local / c);
  let l = local - k * c;
  if (l >= c) {
    // Rounding at the cell edge: the point is on the next cell's corner.
    k += 1;
    l = 0;
  } else if (l < 0) {
    l = 0;
  }
  return [sector + k, l];
}

/** Build a normalized position. Any local offset (even negative or huge) is fine. */
export function makePos(tier: Tier, sector: Vec3, local: Vec3): WorldPos {
  const c = cell(tier);
  const [sx, lx] = wrap(sector[0], local[0], c);
  const [sy, ly] = wrap(sector[1], local[1], c);
  const [sz, lz] = wrap(sector[2], local[2], c);
  return { tier, sector: [sx, sy, sz], local: [lx, ly, lz] };
}

/** Move a position by a delta in meters (camera flight, orbits, etc). */
export function translate(p: WorldPos, d: Vec3): WorldPos {
  return makePos(p.tier, p.sector, [
    p.local[0] + d[0],
    p.local[1] + d[1],
    p.local[2] + d[2],
  ]);
}

function stepFiner(p: WorldPos): WorldPos {
  const r = split(p.tier);
  const f = cell(p.tier + 1);
  const kx = Math.floor(p.local[0] / f);
  const ky = Math.floor(p.local[1] / f);
  const kz = Math.floor(p.local[2] / f);
  return makePos(
    (p.tier + 1) as Tier,
    [p.sector[0] * r + kx, p.sector[1] * r + ky, p.sector[2] * r + kz],
    [p.local[0] - kx * f, p.local[1] - ky * f, p.local[2] - kz * f],
  );
}

function stepCoarser(p: WorldPos): WorldPos {
  const r = split(p.tier - 1);
  const f = cell(p.tier);
  const sx = Math.floor(p.sector[0] / r);
  const sy = Math.floor(p.sector[1] / r);
  const sz = Math.floor(p.sector[2] / r);
  return makePos(
    (p.tier - 1) as Tier,
    [sx, sy, sz],
    [
      (p.sector[0] - sx * r) * f + p.local[0],
      (p.sector[1] - sy * r) * f + p.local[1],
      (p.sector[2] - sz * r) * f + p.local[2],
    ],
  );
}

/**
 * Re-express a position in another tier (this is the floating-origin rebase).
 * Going finer is exact while sector indices stay below 2^53, so only descend
 * toward where the camera actually is; going coarser rounds to the coarser
 * tier's precision.
 */
export function toTier(p: WorldPos, target: Tier): WorldPos {
  let q = p;
  while (q.tier < target) q = stepFiner(q);
  while (q.tier > target) q = stepCoarser(q);
  return q;
}

/**
 * Writes (a - b) in meters into out[offset..offset+2].
 * Same-tier calls do not allocate, so this is the per-object hot path:
 * deltaInto(vertexBuffer, i * 3, star, camera) with a Float32Array output
 * gives the camera-relative float32 positions the renderer uploads.
 * Mixed tiers are brought to the finer tier first (allocates).
 */
export function deltaInto(
  out: Float32Array | Float64Array,
  offset: number,
  a: WorldPos,
  b: WorldPos,
): void {
  const tier = Math.max(a.tier, b.tier) as Tier;
  const pa = a.tier === tier ? a : toTier(a, tier);
  const pb = b.tier === tier ? b : toTier(b, tier);
  const c = cell(tier);
  out[offset] = (pa.sector[0] - pb.sector[0]) * c + (pa.local[0] - pb.local[0]);
  out[offset + 1] = (pa.sector[1] - pb.sector[1]) * c + (pa.local[1] - pb.local[1]);
  out[offset + 2] = (pa.sector[2] - pb.sector[2]) * c + (pa.local[2] - pb.local[2]);
}
