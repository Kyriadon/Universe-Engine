import { translate, type Vec3 } from './coords';
import { createGL } from '../../../graphics/gl';
import { Gravity, blackHoleSource } from '../../../physics/physics';
import {
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
const SPIN_AXIS: Vec3 = [0, Math.sin(VIEW_ANGLE_FROM_POLE_RAD), Math.cos(VIEW_ANGLE_FROM_POLE_RAD)];

// The disk is cut at this radius (R_g) so it stays thin and sharp at the spawn distance.
const DISK_OUTER_RG = 16;

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

// Spawn 30 gravitational radii away from the centre of Sagittarius A*, so the shadow fills about a third of the
// screen. Approximately 190 million kilometres with the current Sgr A* data.
const CAMERA_DISTANCE_M = centralBlackHole.rgM * 30;

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

const renderer = createRenderer();

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
