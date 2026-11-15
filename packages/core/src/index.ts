import { translate, type Vec3 } from './coords';
import { createGL } from '../../../graphics/gl';
import { Gravity, blackHoleSource, distanceForShadowFillRg } from '../../../physics/physics';
import { iscoRadiusRg } from '../../../graphics/shaders';
import {
  DEFAULT_RENDERER_SETTINGS,
  createRenderer,
  type BlackHoleBody,
  type RenderScene,
} from '../../../graphics/renderer';

import {
  MILKYWAY_CENTER,
  createMilkyWay,
  formatMilkyWay,
  type MilkyWayMember,
} from './information/lanikea/local-group/milkyway/milkyway';

import type { BlackHole } from './information/lanikea/local-group/milkyway/sagittarius';

const milkyWay = createMilkyWay();
console.log(formatMilkyWay(milkyWay));

/** The members of kind 'black-hole' that carry the fields the renderer reads. */
function isBlackHole(member: MilkyWayMember): member is BlackHole {
  const b = member as Partial<BlackHole>;

  return (
    member.kind === 'black-hole' &&
    typeof b.scale?.gravitationalRadiusM === 'number' &&
    typeof b.information?.spin.parameter === 'number' &&
    Array.isArray(b.regions)
  );
}

// The data has no spin axis yet, so the axis is derived from the angle the spawn view makes with the pole: 84 degrees is
// almost edge-on, a little above the disk plane, which gives the classic photon-ring look (camera on +Z, axis tilted in Y-Z).
const VIEW_ANGLE_FROM_POLE_RAD = (84 * Math.PI) / 180;

// Sense of rotation about that axis: +1 turns the near side of the disk to the right of the screen (the receding limb on
// the right), -1 the opposite. -1 puts the approaching, Doppler-beamed limb on the right of the shadow. The disk plane
// is the same for both signs, so only the beaming side changes.
const SPIN_SENSE: 1 | -1 = -1;
const SPIN_AXIS: Vec3 = [
  0,
  SPIN_SENSE * Math.sin(VIEW_ANGLE_FROM_POLE_RAD),
  SPIN_SENSE * Math.cos(VIEW_ANGLE_FROM_POLE_RAD),
];

// The blackhole shader traces Schwarzschild geodesics (shadow b = 3 sqrt(3) R_g, photon sphere at 3 R_g), so the inner
// edge of the disk is the Schwarzschild ISCO. The Kerr ISCO of the data's spin (about 2.3 R_g at a = 0.9) lies inside
// the photon sphere of that metric: the disk images then swallow the shadow edge and smear into one blob with no thin
// lensed ribbons. The spin value itself still drives the Keplerian rate of the disk.
const DISK_INNER_RG = iscoRadiusRg(0);

// The disk is cut at this radius (R_g): beyond it the emission is already a faint red, and the cut keeps the shadow the
// dominant shape at the spawn distance. It must stay below the camera's spawn distance (CAMERA_DISTANCE_M below),
// otherwise the camera starts inside the disk.
const DISK_OUTER_RG = 16;

// Display-referred brightness of the hottest disk pixel (settings.blackHole.peakLevel). Lower than the renderer's
// default so the inner edge stays far brighter than the outer disk, which falls away into dim red streaks.
const DISK_PEAK_LEVEL = 6;

/** Convert black-hole information into renderer input. */
function toBlackHoleBody(bh: BlackHole): BlackHoleBody {
  const base = {
    position: bh.position,
    rgM: bh.scale.gravitationalRadiusM,
    spin: bh.information.spin.parameter,
  };

  const flow = bh.regions.find((r) => r.id === 'accretion-flow');

  const oriented = { ...base, spinAxis: SPIN_AXIS };

  return flow?.temperatureK
    ? {
        ...oriented,
        disk: {
          peakTemperatureK: flow.temperatureK.inner,
          innerRg: DISK_INNER_RG,
          outerRg: DISK_OUTER_RG,
        },
      }
    : oriented;
}

const scene: RenderScene = {
  blackHoles: (milkyWay.groups.get('black-hole') ?? [])
    .map((m) => m.data)
    .filter(isBlackHole)
    .map(toBlackHoleBody),
};

// ---------------------------------------------------------------------------
// SPAWN POSITION
// ---------------------------------------------------------------------------

// Find Sagittarius A*.
const centralBlackHole = scene.blackHoles?.[0];

if (!centralBlackHole) {
  throw new Error(
    'Universe Engine: Sagittarius A* was not found in the scene.',
  );
}

// Spawn where the shadow fills this fraction of the view height: a large, truly black shadow with the disk lensed tight
// around it. The distance follows from the lensing law (physics.ts) and the renderer's field of view, so it stays right
// if either changes; about 120 million kilometres with the current Sgr A* data.
const SHADOW_FILL_OF_VIEW = 0.45;
const CAMERA_DISTANCE_M =
  centralBlackHole.rgM * distanceForShadowFillRg(SHADOW_FILL_OF_VIEW, DEFAULT_RENDERER_SETTINGS.verticalFovDeg);

// Position the camera directly along +Z.
const cameraStart = translate(
  MILKYWAY_CENTER,
  [0, 0, CAMERA_DISTANCE_M],
);

// ---------------------------------------------------------------------------
// GRAVITY
// ---------------------------------------------------------------------------

// Every black hole in the scene pulls on everything, including the camera (physics/physics.ts). GM comes from each
// black hole's own gravitational radius, so a second black hole in the data pulls too with no edit here.
const gravity = new Gravity(
  (scene.blackHoles ?? []).map((b) => blackHoleSource(b.position, b.rgM)),
);

// ---------------------------------------------------------------------------
// RENDERER
// ---------------------------------------------------------------------------

const renderer = createRenderer({
  settings: {
    blackHole: { peakLevel: DISK_PEAK_LEVEL },
  },
});

const handle = createGL(
  (frame) => renderer.render(frame, scene),
  {
    camera: cameraStart,
    initialSpeed: 1e6,
    gravity,
    onContextRestored: (gl) => renderer.restore(gl),
  },
);

// ---------------------------------------------------------------------------
// HOT MODULE REPLACEMENT
// ---------------------------------------------------------------------------

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle.dispose();
    renderer.dispose();
  });
}
