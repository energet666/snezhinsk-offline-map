// Which organizations sit inside which building. 2GIS gives organizations as
// points only, so the link to a building is purely geometric: a point inside
// a building's outline belongs to that building.
import { buildingRingIndex, entryContains } from './geo.js';
import { hasPoiIdentity } from './tagstyles.js';

export function buildOrgIndex(data) {
  const buildings = buildingRingIndex(data.buildings.features);
  const orgIndex = new Map();     // building id -> [org properties]
  const matchedPoiIds = new Set(); // POIs already reachable via a building popup
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!hasPoiIdentity(p)) continue;
    const [x, y] = f.geometry.coordinates;
    for (const b of buildings) {
      if (!entryContains(b, x, y)) continue;
      if (!orgIndex.has(b.id)) orgIndex.set(b.id, []);
      orgIndex.get(b.id).push(p);
      matchedPoiIds.add(p.id);
      break;
    }
  }
  return { orgIndex, matchedPoiIds };
}
