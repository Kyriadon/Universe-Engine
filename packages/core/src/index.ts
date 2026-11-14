import { translate } from './coords';
import { createGL } from '../../../graphics/gl';
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

/** Convert black-hole information into renderer input. */
function toBlackHoleBody(bh: BlackHole): BlackHoleBody {
  const base = {
    position: bh.position,
    rgM: bh.scale.gravitationalRadiusM,
    spin: bh.information.spin.parameter,
  };

  const flow = bh.regions.find((r) => r.id === 'accretion-flow');

  return flow?.temperatureK
    ? {
        ...base,
        disk: {
          peakTemperatureK: flow.temperatureK.inner,
        },
      }
    : base;
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

// Spawn 60 gravitational radii away from the centre of Sagittarius A*.
// Approximately 381 million kilometres with the current Sgr A* data.
const CAMERA_DISTANCE_M = centralBlackHole.rgM * 60;

// Position the camera directly along +Z.
const cameraStart = translate(
  MILKYWAY_CENTER,
  [0, 0, CAMERA_DISTANCE_M],
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
