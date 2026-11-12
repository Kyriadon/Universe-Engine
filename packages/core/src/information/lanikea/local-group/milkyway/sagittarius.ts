/**
 * packages/core/src/information/lanikea/local-group/milkyway/sagittarius.ts
 *
 * Sagittarius A*, the supermassive black hole at the center of the Milky Way.
 *
 * Information only: what the object is, where it is, how big it is, its spin, its
 * lifecycle, and what each region around it is like (temperature and appearance).
 * Shapes and terrain belong to geometry/, rotation dynamics, plasma and everything
 * that moves belong to physics/, and look, shaders and rendering belong to
 * graphics/.
 *
 * It default-exports a MilkyWayMember (see milkyway.ts), so createMilkyWay()
 * picks it up with no other edit.
 *
 * Sources (credit each in DATA_SOURCES.md): GRAVITY Collaboration (2022, stellar
 * orbits) for the mass; Baganoff et al. (2003, Chandra) for the Bondi radius and
 * the hot gas around it; the radiatively inefficient accretion flow literature
 * (e.g. Quataert 2003) for the inner flow; Event Horizon Telescope
 * Collaboration (2022) for the first image.
 */

import { Tier, makePos } from '../../../../coords';
import type { MilkyWayMember } from './milkyway';

/** Where a value comes from (README section 8). */
export type DataLabel = 'REAL' | 'DERIVED' | 'PROCEDURAL' | 'HYPOTHETICAL';

/** One shell around the black hole, measured outward from its center. */
export interface BlackHoleRegion {
  readonly id: string;
  readonly name: string;
  readonly innerRadiusM: number;
  readonly outerRadiusM: number;
  /** Electron temperature in kelvin at the inner and outer edge; null where there is no matter. */
  readonly temperatureK: { readonly inner: number; readonly outer: number } | null;
  /** What it looks like, in words. How it is drawn is up to graphics/. */
  readonly appearance: string;
  readonly label: DataLabel;
}

/** One end of a lifecycle: when it happens, what happens, and how sure we are. */
export interface LifecycleEvent {
  /** Years since the Big Bang. */
  readonly years: number;
  readonly description: string;
  readonly label: DataLabel;
}

export interface BlackHole extends MilkyWayMember {
  readonly kind: 'black-hole';
  readonly label: DataLabel;
  readonly information: {
    readonly aliases: readonly string[];
    readonly type: string;
    readonly summary: string;
    readonly massSolarMasses: number;
    readonly massKg: number;
    /** Total power radiated across all wavelengths, in watts. */
    readonly luminosityW: number;
    readonly discoveredYear: number;
    readonly firstImagedYear: number;
    /** Dimensionless spin a/(GM/c): 0 is non-rotating, 1 is the maximum. */
    readonly spin: { readonly parameter: number; readonly label: DataLabel };
  };
  readonly scale: {
    /** GM/c², the unit the inner regions are built from. */
    readonly gravitationalRadiusM: number;
    /** 2GM/c², the event horizon of a non-rotating black hole of this mass. */
    readonly schwarzschildRadiusM: number;
    /** Outer edge of the outermost region, where it hands over to the rest of the galaxy. */
    readonly extentRadiusM: number;
  };
  readonly lifecycle: {
    readonly birth: LifecycleEvent;
    readonly death: LifecycleEvent;
  };
  /** Contiguous shells, innermost first. Each region starts where the one before it ends. */
  readonly regions: readonly BlackHoleRegion[];
}

const GM_SUN = 1.3271244e20; // m^3/s^2, IAU 2015 nominal solar mass parameter
const SOLAR_MASS_KG = 1.98841e30; // GM_SUN divided by G (CODATA 2018)
const SPEED_OF_LIGHT = 299_792_458; // m/s
const METERS_PER_PARSEC = 3.0856775814913673e16;

const MASS_SOLAR_MASSES = 4.297e6;
const R_G = (GM_SUN * MASS_SOLAR_MASSES) / SPEED_OF_LIGHT ** 2;

// Inner radii are the non-rotating (Schwarzschild) reference values. The spin
// below moves them, and physics/ applies it.
const HORIZON_M = 2 * R_G;
const ISCO_M = 6 * R_G; // innermost stable circular orbit
// At the Galactic Center 1 arcsecond is about 0.04 parsec.
const BONDI_M = 0.04 * METERS_PER_PARSEC; // about 1 arcsecond
const HALO_OUTER_M = 0.4 * METERS_PER_PARSEC; // about 10 arcseconds

const sagittariusA: BlackHole = {
  name: 'Sagittarius A*',
  kind: 'black-hole',
  label: 'REAL',

  // The galactic center, by definition. milkyway.ts holds the same point as
  // MILKYWAY_CENTER but cannot be imported here: it imports this file, so that
  // would be circular. If the Local Group file moves the Milky Way, move this too.
  position: makePos(Tier.Galaxy, [0, 0, 0], [0, 0, 0]),

  information: {
    aliases: ['Sgr A*'],
    type: 'Supermassive black hole',
    summary:
      'The compact radio source and black hole at the dynamical center of the Milky Way, ' +
      'weighed by following stars that orbit it. It is unusually quiet for its mass.',
    massSolarMasses: MASS_SOLAR_MASSES,
    massKg: MASS_SOLAR_MASSES * SOLAR_MASS_KG,
    luminosityW: 1e29, // about 1e36 erg/s, order 1e-9 of its Eddington limit
    discoveredYear: 1974,
    firstImagedYear: 2022,
    // Not measured: EHT and GRAVITY do not pin the spin down. Placeholder until they do.
    spin: { parameter: 0.9, label: 'HYPOTHETICAL' },
  },

  scale: {
    gravitationalRadiusM: R_G,
    schwarzschildRadiusM: HORIZON_M,
    extentRadiusM: HALO_OUTER_M,
  },

  lifecycle: {
    birth: {
      years: 1e9,
      description:
        'Grew from a seed black hole in the early universe. The real formation time is ' +
        'not known; this is a placeholder.',
      label: 'HYPOTHETICAL',
    },
    death: {
      years: 1.67e87,
      description:
        'Slow evaporation by Hawking radiation, counting no further growth. This ' +
        'follows from theory and has never been observed.',
      label: 'HYPOTHETICAL',
    },
  },

  regions: [
    {
      id: 'event-horizon',
      name: 'Event horizon',
      innerRadiusM: 0,
      outerRadiusM: HORIZON_M,
      temperatureK: null,
      appearance:
        'A perfectly black sphere. Seen from afar it is a dark silhouette against the ' +
        'glowing gas behind it, about 2.6 times wider than the horizon itself because ' +
        'gravity bends the light around it.',
      label: 'DERIVED',
    },
    {
      id: 'plunging-region',
      name: 'Plunging region',
      innerRadiusM: HORIZON_M,
      outerRadiusM: ISCO_M,
      temperatureK: { inner: 1e10, outer: 1e10 },
      appearance:
        'Dim, hot gas past its last stable orbit, falling in fast. Light from it is ' +
        'stretched and lensed into thin arcs hugging the shadow. The photon sphere, ' +
        'where light itself can orbit, sits here at 3 gravitational radii.',
      label: 'DERIVED',
    },
    {
      id: 'accretion-flow',
      name: 'Hot accretion flow',
      innerRadiusM: ISCO_M,
      outerRadiusM: BONDI_M,
      temperatureK: { inner: 1e10, outer: 2.3e7 },
      appearance:
        'A thick, puffed-up, very hot cloud of plasma rather than a thin disk, and ' +
        'extremely faint. It glows in radio, sub-millimeter and infrared light, shows as ' +
        'the lopsided bright ring in the Event Horizon Telescope image, and flares ' +
        'briefly in the near-infrared and X-rays.',
      label: 'DERIVED',
    },
    {
      id: 'hot-gas-halo',
      name: 'Hot gas halo',
      innerRadiusM: BONDI_M,
      outerRadiusM: HALO_OUTER_M,
      temperatureK: { inner: 2.3e7, outer: 1.5e7 },
      appearance:
        'A faint, diffuse X-ray haze that thins and cools outward. It is gas shed by ' +
        'nearby massive stars, shocked to millions of degrees and slowly captured by the ' +
        'black hole.',
      label: 'REAL',
    },
  ],
};

export default sagittariusA;
