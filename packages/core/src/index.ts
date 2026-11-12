import { createGL } from '../../../graphics/gl';
import { createMilkyWay, formatMilkyWay } from './information/lanikea/local-group/milkyway/milkyway';

console.log(formatMilkyWay(createMilkyWay()));

createGL(({ gl, width, height }) => {
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.02, 0.03, 0.08, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
});