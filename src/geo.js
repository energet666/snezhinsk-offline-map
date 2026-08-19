// Plain geometry on GeoJSON coordinates ([lon, lat] pairs). Nothing here
// touches Leaflet except polygonCentroid, which returns an L.latLng for
// convenience — every caller wants one.

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Building polygons prepared for repeated point-in-polygon lookups: outer
// ring plus its bounding box, so the (cheap) box test can reject most
// candidates before the (expensive) ray casting runs.
export function buildingRingIndex(features) {
  return features.map(f => {
    const ring = f.geometry.coordinates[0];
    return { id: f.properties.id, props: f.properties, ring, bbox: ringBBox(ring) };
  });
}

export function entryContains(entry, x, y) {
  const b = entry.bbox;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  return pointInRing(x, y, entry.ring);
}

function distToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x1 = ring[j][0], y1 = ring[j][1], x2 = ring[i][0], y2 = ring[i][1];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best;
}

// Pole of inaccessibility: coarse-to-fine grid search for the point inside
// the ring farthest from any edge. Used as a fallback for concave (e.g.
// L-shaped) buildings, where the area centroid can land outside the shape.
function poleOfInaccessibility(ring, { minX, minY, maxX, maxY }) {
  let best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, d: -Infinity };
  let cell = Math.max(maxX - minX, maxY - minY) / 8 || 1e-6;
  let cx0 = minX, cy0 = minY, cx1 = maxX, cy1 = maxY;
  for (let pass = 0; pass < 6; pass++) {
    for (let gx = cx0; gx <= cx1 + cell / 2; gx += cell) {
      for (let gy = cy0; gy <= cy1 + cell / 2; gy += cell) {
        if (!pointInRing(gx, gy, ring)) continue;
        const d = distToRing(gx, gy, ring);
        if (d > best.d) best = { x: gx, y: gy, d };
      }
    }
    cx0 = best.x - cell; cx1 = best.x + cell;
    cy0 = best.y - cell; cy1 = best.y + cell;
    cell /= 4;
  }
  return best;
}

export function polygonCentroid(coords) {
  // coords: [ [ [lon,lat], ... ], ...holes ] — outer ring only, matching
  // how the rest of the app (pointInRing/buildOrgIndex) treats buildings.
  const ring = coords[0];
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area *= 0.5;

  let x, y;
  if (Math.abs(area) < 1e-14) {
    // Degenerate (zero-area) ring — fall back to a vertex average.
    x = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    y = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  } else {
    x = cx / (6 * area);
    y = cy / (6 * area);
  }

  // The area centroid of a concave (e.g. L-shaped) polygon can fall
  // outside the shape entirely — pull it back inside via a grid search.
  if (!pointInRing(x, y, ring)) {
    const pole = poleOfInaccessibility(ring, ringBBox(ring));
    x = pole.x; y = pole.y;
  }
  return L.latLng(y, x);
}
