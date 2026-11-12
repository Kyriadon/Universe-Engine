import { createMilkyWay, formatMilkyWay } from '../packages/core/src/information/lanikea/local-group/milkyway/milkyway';

const mw = createMilkyWay();
console.log(formatMilkyWay(mw));

// Full Sgr A* data (mass, regions, lifecycle):
const sgr = mw.members.find((m) => m.data.name === 'Sagittarius A*');
console.log(JSON.stringify(sgr?.data, null, 2));
