import { createGL } from '../../../graphics/gl';
import { createRenderer, type BlackHoleBody, type RenderScene } from '../../../graphics/renderer';
import {
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

/** Data to render input: only what the data file states. Axis, disk size and look use renderer defaults. */
function toBlackHoleBody(bh: BlackHole): BlackHoleBody {
  const base = {
    position: bh.position,
    rgM: bh.scale.gravitationalRadiusM,
    spin: bh.information.spin.parameter,
  };
  const flow = bh.regions.find((r) => r.id === 'accretion-flow');
  return flow?.temperatureK
    ? { ...base, disk: { peakTemperatureK: flow.temperatureK.inner } }
    : base;
}

const scene: RenderScene = {
  blackHoles: (milkyWay.groups.get('black-hole') ?? [])
    .map((m) => m.data)
    .filter(isBlackHole)
    .map(toBlackHoleBody),
};

const renderer = createRenderer();
const handle = createGL((frame) => renderer.render(frame, scene), {
  onContextRestored: (gl) => renderer.restore(gl),
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle.dispose();
    renderer.dispose();
  });
}
