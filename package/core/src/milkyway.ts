/**
 * packages/core/src/information/lanikea/local-group/milkyway/milkyway.ts
 *
 * Builds the Milky Way from every other file under this folder.
 *
 * Every other .ts file in this folder (at any depth, e.g. solar/solar.ts) must
 * default-export a MilkyWayMember. createMilkyWay() lists those files, reads
 * each member's position, measures its distance from the galactic center,
 * groups the members by `kind`, and returns the galaxy. A file that breaks the
 * contract makes it throw, naming every offending file, so nothing is skipped
 * silently.
 *
 * Discovery uses Vite's import.meta.glob, so it works in the dev server, in
 * production builds and under vite-node. Adding a file to this folder adds it
 * to the galaxy with no other edit.
 */

/// <reference types="vite/client" />

import { Tier, deltaInto, makePos, type WorldPos } from '../../../../coords';

/** What every file under this folder must default-export. Extra fields are kept. */
export interface MilkyWayMember {
  /** Display name, e.g. "Solar System". */
  readonly name: string;
  /** Group key, e.g. "system", "star", "black-hole", "nebula", "rogue-planet". */
  readonly kind: string;
  /** Where it is, in the universe frame from coords.ts. */
  readonly position: WorldPos;
}

export interface Member {
  /** Path relative to this folder, e.g. "solar/solar.ts". */
  readonly file: string;
  /** The file's default export, exactly as written. */
  readonly data: MilkyWayMember;
  readonly distanceFromCenterM: number;
}

export interface MilkyWay {
  readonly name: string;
  readonly center: WorldPos;
  /** Every discovered member file, sorted by path. */
  readonly files: readonly string[];
  /** Every member, nearest to the center first. */
  readonly members: readonly Member[];
  /** Members grouped by `kind`, kinds sorted by name, members nearest first. */
  readonly groups: ReadonlyMap<string, readonly Member[]>;
  /** Distance from the center to the farthest member, in meters (0 if none). */
  readonly radiusM: number;
}

/**
 * The galactic center (Sagittarius A*). Placed at the corner of Galaxy-tier cell
 * [0, 0, 0] until the Local Group file defines where the Milky Way sits.
 */
export const MILKYWAY_CENTER: WorldPos = makePos(Tier.Galaxy, [0, 0, 0], [0, 0, 0]);

const METERS_PER_LIGHT_YEAR = 9_460_730_472_580_800;

/** Every file under this folder except this one. Keys look like "./solar/solar.ts". */
const modules = import.meta.glob<{ default?: unknown }>(['./**/*.ts', '!./milkyway.ts'], {
  eager: true,
});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isVec3(v: unknown, test: (n: number) => boolean): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && test(n));
}

function isWorldPos(v: unknown): v is WorldPos {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as { tier?: unknown; sector?: unknown; local?: unknown };
  return (
    typeof p.tier === 'number' &&
    Number.isInteger(p.tier) &&
    p.tier >= Tier.Universe &&
    p.tier <= Tier.Surface &&
    isVec3(p.sector, Number.isSafeInteger) &&
    isVec3(p.local, Number.isFinite)
  );
}

/** Why a default export is not a MilkyWayMember, or null when it is one. */
function contractProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'default export is missing or not an object';
  const m = v as { name?: unknown; kind?: unknown; position?: unknown };
  if (typeof m.name !== 'string' || m.name === '') return '`name` must be a non-empty string';
  if (typeof m.kind !== 'string' || m.kind === '') return '`kind` must be a non-empty string';
  if (!isWorldPos(m.position)) {
    return '`position` must be a WorldPos from coords.ts (integer tier 0-5, 3 safe-integer sector indices, 3 finite local offsets)';
  }
  return null;
}

const scratch = new Float64Array(3);

function distanceM(a: WorldPos, b: WorldPos): number {
  deltaInto(scratch, 0, a, b);
  return Math.hypot(scratch[0] as number, scratch[1] as number, scratch[2] as number);
}

/** Discover, validate, measure and group every member file into the galaxy. */
export function createMilkyWay(): MilkyWay {
  const entries = Object.entries(modules).sort(([a], [b]) => byText(a, b));
  const members: Member[] = [];
  const problems: string[] = [];

  for (const [key, mod] of entries) {
    const file = key.replace(/^\.\//, '');
    const data = mod.default;
    const problem = contractProblem(data);
    if (problem !== null) {
      problems.push(`${file}: ${problem}`);
      continue;
    }
    const member = data as MilkyWayMember;
    members.push({ file, data: member, distanceFromCenterM: distanceM(member.position, MILKYWAY_CENTER) });
  }

  if (problems.length > 0) {
    throw new Error(
      `Milky Way: ${problems.length} file(s) do not follow the MilkyWayMember contract:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  const files = members.map((m) => m.file);
  members.sort((a, b) => a.distanceFromCenterM - b.distanceFromCenterM || byText(a.file, b.file));

  const byKind = new Map<string, Member[]>();
  for (const m of members) {
    const list = byKind.get(m.data.kind);
    if (list) list.push(m);
    else byKind.set(m.data.kind, [m]);
  }
  const groups = new Map([...byKind].sort(([a], [b]) => byText(a, b)));

  const last = members[members.length - 1];
  return {
    name: 'Milky Way',
    center: MILKYWAY_CENTER,
    files,
    members,
    groups,
    radiusM: last ? last.distanceFromCenterM : 0,
  };
}

const lightYears = (m: number): string =>
  `${(m / METERS_PER_LIGHT_YEAR).toLocaleString('en-US', { maximumFractionDigits: 1 })} ly`;

/** Human-readable listing: the files found, then each group with distances. */
export function formatMilkyWay(mw: MilkyWay): string {
  const lines = [
    `${mw.name}: ${mw.members.length} object(s) in ${mw.groups.size} group(s), radius ${lightYears(mw.radiusM)}`,
    '',
    `Files (${mw.files.length}):`,
    ...mw.files.map((f) => `  ${f}`),
  ];
  for (const [kind, list] of mw.groups) {
    lines.push('', `${kind} (${list.length}):`);
    for (const m of list) {
      lines.push(`  ${m.data.name}: ${lightYears(m.distanceFromCenterM)} from center  [${m.file}]`);
    }
  }
  return lines.join('\n');
}
