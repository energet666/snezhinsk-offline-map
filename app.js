const CITY_CENTER = [56.0870090, 60.7326740];
const INITIAL_ZOOM = 14;
const MAX_ZOOM = 19;
const MAX_NATIVE_SAT_ZOOM = 17;

// Restore the last-viewed map position/zoom so a page refresh lands exactly
// where the user left off, instead of always resetting to CITY_CENTER.
function getSavedView() {
  try {
    const v = JSON.parse(localStorage.getItem('mapView'));
    if (v && Array.isArray(v.center) && v.center.length === 2 && typeof v.zoom === 'number') return v;
  } catch (e) { /* malformed/absent — fall back to the default view */ }
  return null;
}
const savedView = getSavedView();

const map = L.map('map', {
  center: savedView ? savedView.center : CITY_CENTER,
  zoom: savedView ? savedView.zoom : INITIAL_ZOOM,
  maxZoom: MAX_ZOOM,
  zoomControl: false,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);
map.on('moveend', () => {
  const c = map.getCenter();
  localStorage.setItem('mapView', JSON.stringify({ center: [c.lat, c.lng], zoom: map.getZoom() }));
});

// ---------- Base layer: satellite (local Esri tiles) ----------
const SATELLITE_TILE_OPTS = {
  maxZoom: MAX_ZOOM,
  maxNativeZoom: MAX_NATIVE_SAT_ZOOM,
  attribution: 'Esri, Maxar, Earthstar Geographics',
  errorTileUrl: 'lib/images/marker-shadow.png',
};
const satelliteLayer = L.tileLayer('tiles/{z}/{x}/{y}.png', SATELLITE_TILE_OPTS);
// A second, independent tile layer for "Гибрид" (same local tiles, served
// from the browser cache) — reusing satelliteLayer itself as a child of the
// hybrid layer group would make map.hasLayer(satelliteLayer) true whenever
// either base layer is active. Leaflet's layers control re-syncs ALL of its
// inputs on every click inside the control, not just the one clicked, so
// toggling e.g. "Названия и объекты" while in Гибрид would see the
// "Спутник" radio unchecked but hasLayer(satelliteLayer) true, read that as
// a mismatch, and remove the (shared) tile layer — the imagery would vanish
// even though Гибрид was still selected.
const satelliteLayerHybrid = L.tileLayer('tiles/{z}/{x}/{y}.png', SATELLITE_TILE_OPTS);

// ---------- Base layer: vector "map" style ----------
const mapLayerGroup = L.layerGroup();

// Landuse/roads/water get their own pane, pinned below the default
// overlayPane (where buildings live) via z-index. Without this, toggling
// Карта -> Спутник -> Карта removes and re-adds mapLayerGroup, and Leaflet's
// SVG renderer re-appends its paths at the end of the shared <svg> — after
// the buildings paths, which never left the DOM — so the landuse polygons
// end up stacked on top of buildings instead of under them.
map.createPane('landusePane');
map.getPane('landusePane').style.zIndex = 350;

const HYBRID_ROAD_OPACITY = 0.55;

// Buildings live outside the swappable base layer so their click popups
// keep working in satellite/hybrid mode too — just invisible there.
let satelliteActive = false;
function isGarage(feature) {
  const b = feature && feature.properties.building;
  return b === 'garage' || b === 'garages';
}
function buildingStyle(feature) {
  if (satelliteActive) return { stroke: false, fill: true, fillOpacity: 0 };
  return isGarage(feature)
    ? { color: '#a99bb8', weight: 1, fillColor: '#d6cddb', fillOpacity: 0.95 }
    : { color: '#c4b9a8', weight: 1, fillColor: '#d9d0c4', fillOpacity: 0.95 };
}

let dataStore = {}; // holds loaded geojson for search index

function fetchJSON(path) {
  return fetch(path).then(r => {
    if (!r.ok) throw new Error('failed to load ' + path);
    return r.json();
  });
}

// ---------- Organizations-in-building index (point-in-polygon) ----------
function pointInRing(x, y, ring) {
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

function buildOrgIndex(data) {
  const buildingBoxes = data.buildings.features.map(f => {
    const ring = f.geometry.coordinates[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { id: f.properties.id, ring, minX, minY, maxX, maxY };
  });
  const orgIndex = new Map();
  const matchedPoiIds = new Set();
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!p.name && !p.amenity && !p.shop && !p.office && !p.healthcare && !p.craft && !p.tourism && !p.leisure) continue;
    const [x, y] = f.geometry.coordinates;
    for (const b of buildingBoxes) {
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (pointInRing(x, y, b.ring)) {
        if (!orgIndex.has(b.id)) orgIndex.set(b.id, []);
        orgIndex.get(b.id).push(p);
        matchedPoiIds.add(p.id);
        break;
      }
    }
  }
  return { orgIndex, matchedPoiIds };
}

// Phone/hours/website block shared by the building-popup org list and the
// standalone-POI popup (see standalonePoiPopupHtml).
function orgDetailsHtml(o) {
  let details = '';
  if (o.phone) details += `<div class="org-detail">☎ ${escapeHtml(o.phone)}</div>`;
  if (o.opening_hours) {
    const days = o.opening_hours.split('; ').map(d => `<div>${escapeHtml(d)}</div>`).join('');
    details += `<div class="org-detail org-hours">🕑<div class="org-hours-days">${days}</div></div>`;
  }
  if (o.website) details += `<div class="org-detail"><a href="${escapeHtml(o.website)}" target="_blank" rel="noopener">${escapeHtml(o.website)}</a></div>`;
  return details;
}

// Popup for a POI with no enclosing building (e.g. школа 135) — there's no
// polygon to click for details, so the label itself carries the popup.
// Only one organization here, so no need for the building popup's
// click-to-expand list — just show everything.
function standalonePoiPopupHtml(p) {
  const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
  let html = '';
  if (p.name) html += `<b>${escapeHtml(p.name)}</b><br>`;
  if (addr) html += `${escapeHtml(addr)}<br>`;
  const cat = poiLabel(p);
  if (cat) html += `<span class="org-cat">${escapeHtml(cat)}</span>`;
  html += orgDetailsHtml(p);
  return html;
}

function buildMapLayer(data, orgIndex) {
  // Landuse
  const landuse = L.geoJSON(data.landuse, {
    pane: 'landusePane',
    style: f => ({
      color: 'none',
      weight: 0,
      fillColor: landuseColor(f),
      fillOpacity: 0.9,
    }),
  });
  landuse.addTo(mapLayerGroup);

  // Water
  const water = L.geoJSON(data.water, {
    pane: 'landusePane',
    style: () => ({ color: '#a3ccdb', weight: 1, fillColor: '#aad3df', fillOpacity: 1 }),
  });
  water.addTo(mapLayerGroup);

  // Railway
  const railway = L.geoJSON(data.railway, {
    pane: 'landusePane',
    style: () => ({ color: '#8a8a8a', weight: 2, dashArray: '1,6' }),
  });
  railway.addTo(mapLayerGroup);

  // Roads - casing pass then center pass for nicer look. Built twice: full
  // opacity for the "Карта" base layer, and a dimmer copy (see
  // HYBRID_ROAD_OPACITY) for the separate "Гибрид" base layer, which lays
  // roads over the satellite photo instead of replacing it.
  function buildRoadLayers(opacity) {
    const group = L.layerGroup();
    L.geoJSON(data.roads, {
      pane: 'landusePane',
      style: f => {
        const s = roadStyle(f);
        if (!s.casing) return { opacity: 0 };
        return { color: s.casing, weight: s.weight + 1.6, opacity, lineCap: 'round', lineJoin: 'round' };
      },
    }).addTo(group);
    L.geoJSON(data.roads, {
      pane: 'landusePane',
      style: f => {
        const s = roadStyle(f);
        return {
          color: s.color,
          weight: s.weight,
          opacity,
          lineCap: 'round',
          lineJoin: 'round',
          dashArray: s.dashed ? '4,4' : null,
        };
      },
    }).addTo(group);
    return group;
  }
  buildRoadLayers(1).addTo(mapLayerGroup);
  const hybridRoadsGroup = buildRoadLayers(HYBRID_ROAD_OPACITY);

  // Buildings — not added to mapLayerGroup, see buildingStyle() above
  const buildings = L.geoJSON(data.buildings, {
    style: buildingStyle,
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const orgs = orgIndex.get(p.id) || [];
      const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
      if (!p.name && !addr && !orgs.length) {
        if (isGarage(f)) layer.bindPopup('Гараж');
        return;
      }
      let html = '';
      if (p.name) html += `<b>${escapeHtml(p.name)}</b><br>`;
      if (addr) html += `${escapeHtml(addr)}<br>`;
      if (orgs.length) {
        html += '<div class="building-orgs">' + orgs.map(o => {
          const cat = poiLabel(o);
          const bank = o.amenity === 'atm' ? bankFromWebsite(o.website) : '';
          const title = o.name || cat || 'организация';
          const subtitle = o.name ? cat : bank;
          const details = orgDetailsHtml(o);
          const clickable = details ? ' org-item-clickable' : '';
          return `<div class="org-item${clickable}">` +
            `<div class="org-name"><b>${escapeHtml(title)}</b>` +
            (subtitle ? ` <span class="org-cat">(${escapeHtml(subtitle)})</span>` : '') +
            '</div>' +
            (details ? `<div class="org-detail-panel" hidden>${details}</div>` : '') +
            '</div>';
        }).join('') + '</div>';
      }
      layer.bindPopup(html);
      // Details (phone/hours/website) start hidden — only the org name list
      // shows by default; clicking a name reveals that org's details.
      layer.on('popupopen', () => {
        const el = layer.getPopup().getElement();
        if (!el || el.dataset.orgsWired) return;
        el.dataset.orgsWired = '1';
        el.addEventListener('click', (e) => {
          const item = e.target.closest('.org-item-clickable');
          if (!item) return;
          const panel = item.querySelector('.org-detail-panel');
          if (panel) panel.hidden = !panel.hidden;
        });
      });
    },
  });
  return { buildings, hybridRoadsGroup };
}

// ---------- Parking overlay (separate checkbox) ----------
function buildParkingLayer(data) {
  const layer = L.geoJSON(data.parking, {
    style: () => ({ color: PARKING_STYLE.border, weight: 1, fillColor: PARKING_STYLE.fill, fillOpacity: 0.85 }),
    pointToLayer: (f, latlng) => L.marker(latlng, {
      icon: L.divIcon({
        className: 'parking-marker',
        html: 'P',
        iconSize: [18, 18],
      }),
    }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
      const title = p.name ? escapeHtml(p.name) : 'Парковка';
      layer.bindPopup(title + (addr ? '<br>' + escapeHtml(addr) : ''));
    },
  });
  return layer;
}

// ---------- Memorials overlay (monuments, sculptures, plaques) ----------
// Markers are built once and kept, rather than re-created on every move like
// the labels are: re-creating them would close an open popup as soon as
// Leaflet pans the map to fit that popup. Zoom filtering is done by adding /
// removing the whole plaques sub-group instead.
const memorialsGroup = L.layerGroup();
const monumentMarkers = L.layerGroup();
const plaqueMarkers = L.layerGroup();

function buildMemorialsLayer(data) {
  memorialsGroup.addLayer(monumentMarkers);
  for (const f of data.memorials.features) {
    const p = f.properties;
    const plaque = isPlaque(p);
    const c = f.geometry.coordinates;
    const icon = L.divIcon({
      className: plaque ? 'memorial-marker memorial-marker-plaque' : 'memorial-marker',
      html: plaque ? '' : '★',
      iconSize: plaque ? [12, 12] : [18, 18],
    });
    const marker = L.marker(L.latLng(c[1], c[0]), { icon, title: p.name });

    const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
    let html = `<b>${escapeHtml(p.name)}</b><br>` +
      `<span class="memorial-type">${escapeHtml(memorialTypeLabel(p))}</span>`;
    if (addr) html += `<br>${escapeHtml(addr)}`;
    if (p.inscription && p.inscription !== p.name) html += `<br>«${escapeHtml(p.inscription)}»`;
    if (p.description) html += `<br>${escapeHtml(p.description)}`;
    if (p.artist) html += `<br>скульптор: ${escapeHtml(p.artist)}`;
    html += `<div class="memorial-source">источник: ${escapeHtml(p.source)}</div>`;
    marker.bindPopup(html);

    marker.addTo(plaque ? plaqueMarkers : monumentMarkers);
  }
}

// Plaques only from MEMORIAL_PLAQUE_MIN_ZOOM up — at city zoom they'd bury
// the monuments under a cloud of near-identical dots on the same few streets.
function syncMemorialZoom() {
  const showPlaques = map.getZoom() >= MEMORIAL_PLAQUE_MIN_ZOOM;
  if (showPlaques && !memorialsGroup.hasLayer(plaqueMarkers)) memorialsGroup.addLayer(plaqueMarkers);
  else if (!showPlaques && memorialsGroup.hasLayer(plaqueMarkers)) memorialsGroup.removeLayer(plaqueMarkers);

  const showMonuments = map.getZoom() >= MEMORIAL_MONUMENT_MIN_ZOOM;
  if (showMonuments && !memorialsGroup.hasLayer(monumentMarkers)) memorialsGroup.addLayer(monumentMarkers);
  else if (!showMonuments && memorialsGroup.hasLayer(monumentMarkers)) memorialsGroup.removeLayer(monumentMarkers);
}

// ---------- Labels overlay (works on top of both base modes, like Google hybrid) ----------
const labelsGroup = L.layerGroup();
let labelPoints = []; // {latlng, text, minZoom, kind} - housenumbers only
let namedStreets = []; // {name, latlngs, bounds} - rendered along the road itself

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
function poleOfInaccessibility(ring, minX, minY, maxX, maxY) {
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

function polygonCentroid(coords) {
  // coords: [ [ [lon,lat], ... ], ...holes ] — outer ring only, matching
  // how the rest of the app (pointInRing/buildOrgIndex) treats buildings.
  const ring = coords[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
    if (x2 < minX) minX = x2;
    if (x2 > maxX) maxX = x2;
    if (y2 < minY) minY = y2;
    if (y2 > maxY) maxY = y2;
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
    const pole = poleOfInaccessibility(ring, minX, minY, maxX, maxY);
    x = pole.x; y = pole.y;
  }
  return L.latLng(y, x);
}

function buildLabelIndex(data, matchedPoiIds, orgIndex) {
  labelPoints = [];
  namedStreets = [];

  // Street name labels — stored as full geometry so they can be drawn
  // rotated along the road and repeated along long streets.
  for (const f of data.roads.features) {
    if (!f.properties.name) continue;
    const latlngs = f.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    namedStreets.push({
      name: f.properties.name,
      latlngs,
      bounds: L.latLngBounds(latlngs),
    });
  }

  // House number labels
  for (const f of data.buildings.features) {
    if (!f.properties.housenumber) continue;
    const c = polygonCentroid(f.geometry.coordinates);
    labelPoints.push({
      latlng: c,
      text: f.properties.housenumber,
      minZoom: 17,
      kind: 'housenumber',
    });
  }

  // Admin/social building labels (schools, kindergartens, clinics, …).
  // Most carry no `name` in OSM, so fall back to a generic type label. Some
  // buildings carry no admin tag at all (e.g. школа 135's OSM relation is
  // only tagged building=yes+addr, not amenity=school) — for those, fall
  // back to the category of whatever 2GIS organization is matched inside.
  for (const f of data.buildings.features) {
    const p = f.properties;
    const orgs = orgIndex.get(p.id) || [];
    const matchedOrgLabel = orgs.map(o => adminBuildingLabel(o)).find(Boolean);
    const generic = adminBuildingLabel(p) || matchedOrgLabel;
    if (!generic) continue;
    const orgName = orgs.find(o => adminBuildingLabel(o))?.name;
    labelPoints.push({
      latlng: polygonCentroid(f.geometry.coordinates),
      text: p.name || orgName || generic,
      minZoom: ADMIN_LABEL_MIN_ZOOM,
      kind: 'admin',
    });
  }

  // Same admin labeling for standalone POIs (e.g. школа 135, tagged as a
  // point with no enclosing building at all in OSM) — skip ones already
  // surfaced via a building popup (buildOrgIndex) to avoid double-labeling.
  // Unlike building-derived admin labels (whose phone/hours/website is one
  // click away on the building polygon itself), these have no polygon to
  // click at all — bind a popup directly on the label so that info isn't
  // simply unreachable.
  for (const f of data.poi.features) {
    const p = f.properties;
    if (matchedPoiIds.has(p.id)) continue;
    const generic = adminBuildingLabel(p);
    if (!generic) continue;
    const c = f.geometry.coordinates;
    labelPoints.push({
      latlng: L.latLng(c[1], c[0]),
      text: p.name || generic,
      minZoom: ADMIN_LABEL_MIN_ZOOM,
      kind: 'admin',
      popupHtml: standalonePoiPopupHtml(p),
    });
  }

  // Stadiums with a resolvable name/sport label (see stadiumLabel).
  for (const f of data.landuse.features) {
    const text = stadiumLabel(f.properties);
    if (!text) continue;
    labelPoints.push({
      latlng: polygonCentroid(f.geometry.coordinates),
      text,
      minZoom: ADMIN_LABEL_MIN_ZOOM,
      kind: 'admin',
    });
  }

  // Monument names next to their marker (plaques stay marker-only, see
  // buildMemorialsLayer — their names are long dedications, not map labels).
  for (const f of data.memorials.features) {
    const p = f.properties;
    if (isPlaque(p)) continue;
    const c = f.geometry.coordinates;
    labelPoints.push({
      latlng: L.latLng(c[1], c[0]),
      text: memorialLabel(p),
      minZoom: MEMORIAL_LABEL_MIN_ZOOM,
      kind: 'memorial',
    });
  }

  // addr_nodes exist to label points OSM never attached to a building
  // footprint. A node that falls *inside* an already-addressed building is
  // usually a stale/imprecise per-entrance tag (see e.g. "Ломинского 1":
  // two addr_nodes there say "1А" while the building itself — confirmed via
  // 2GIS — is "1") rather than a genuinely separate sub-address, so it
  // would just add a second, conflicting number on top of the same
  // building. Skip those; only label addr_nodes that are actually outside
  // any addressed building.
  const addressedBuildingBoxes = data.buildings.features
    .filter(f => f.properties.housenumber)
    .map(f => {
      const ring = f.geometry.coordinates[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { ring, minX, minY, maxX, maxY };
    });
  for (const f of data.addr_nodes.features) {
    if (!f.properties.housenumber) continue;
    const [x, y] = f.geometry.coordinates;
    const insideAddressedBuilding = addressedBuildingBoxes.some(b =>
      x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInRing(x, y, b.ring));
    if (insideAddressedBuilding) continue;
    labelPoints.push({
      latlng: L.latLng(y, x),
      text: f.properties.housenumber,
      minZoom: 17,
      kind: 'housenumber',
    });
  }

  // Note: organizations are intentionally not shown as always-on labels —
  // they surface via a click on their building (see buildMapLayer) or search.

  dedupeHousenumberLabels();
}

// Housenumber labels come from two sources (building polygons and
// standalone addr_nodes) that can both carry the same address — e.g. a
// building split into several OSM ways all tagged with the same
// addr:housenumber, or a building plus a nearby addr_node for one of its
// entrances/units sharing the number. Collapse near-duplicates (same text,
// within a few metres) into a single label instead of stacking copies.
function dedupeHousenumberLabels() {
  const kept = [];
  for (const lp of labelPoints) {
    if (lp.kind !== 'housenumber') { kept.push(lp); continue; }
    const dup = kept.some(k => k.kind === 'housenumber' && k.text === lp.text && map.distance(k.latlng, lp.latlng) < 20);
    if (!dup) kept.push(lp);
  }
  labelPoints = kept;
}

const MAX_LABELS_RENDERED = 400;
const ADMIN_LABEL_MIN_ZOOM = 17;
const STREET_LABEL_MIN_ZOOM = 15;
const STREET_LABEL_STEP_PX = 260; // spacing between repeated labels along a long street
const STREET_LABEL_MIN_LEN_PX = 40; // skip streets too short to fit a label

function addStreetLabels(zoom, bounds, budget) {
  let count = 0;

  // OSM splits long streets into many short ways (one per block/intersection),
  // and namedStreets has one entry per way. Placing labels independently per
  // way — each getting its own STREET_LABEL_STEP_PX spacing — makes a street
  // name repeat far more often than intended wherever it's cut into short
  // segments. Group by name first and track already-placed label positions
  // across the whole street, so spacing is enforced street-wide, not per-way.
  const byName = new Map();
  for (const street of namedStreets) {
    if (!bounds.intersects(street.bounds)) continue;
    if (!byName.has(street.name)) byName.set(street.name, []);
    byName.get(street.name).push(street);
  }

  for (const segments of byName.values()) {
    if (count >= budget) break;
    const placed = [];

    for (const street of segments) {
      if (count >= budget) break;

      const pts = street.latlngs.map(ll => map.project(ll, zoom));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const total = cum[cum.length - 1];
      if (total < STREET_LABEL_MIN_LEN_PX) continue;

      const positions = [];
      if (total < STREET_LABEL_STEP_PX) {
        positions.push(total / 2);
      } else {
        const n = Math.floor(total / STREET_LABEL_STEP_PX);
        const offset = (total - n * STREET_LABEL_STEP_PX) / 2 + STREET_LABEL_STEP_PX / 2;
        for (let i = 0; i < n; i++) positions.push(offset + i * STREET_LABEL_STEP_PX);
      }

      for (const t of positions) {
        if (count >= budget) break;
        let idx = 1;
        while (idx < cum.length - 1 && cum[idx] < t) idx++;
        const p0 = pts[idx - 1], p1 = pts[idx];
        const segLen = cum[idx] - cum[idx - 1] || 1;
        const frac = (t - cum[idx - 1]) / segLen;
        const x = p0.x + (p1.x - p0.x) * frac;
        const y = p0.y + (p1.y - p0.y) * frac;
        const latlng = map.unproject(L.point(x, y), zoom);
        if (!bounds.contains(latlng)) continue;

        const pt = L.point(x, y);
        if (placed.some(p => p.distanceTo(pt) < STREET_LABEL_STEP_PX)) continue;
        placed.push(pt);

        let angle = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;

        count++;
        const icon = L.divIcon({
          className: 'map-label map-label-street',
          html: `<span class="label-inner" style="transform: translate(-50%,-50%) rotate(${angle.toFixed(1)}deg)">${escapeHtml(street.name)}</span>`,
          iconSize: null,
        });
        L.marker(latlng, { icon, interactive: false }).addTo(labelsGroup);
      }
    }
  }
  return count;
}

function renderLabels() {
  labelsGroup.clearLayers();
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  let count = 0;

  if (zoom >= STREET_LABEL_MIN_ZOOM) {
    count += addStreetLabels(zoom, bounds, MAX_LABELS_RENDERED);
  }

  // Memorial names belong to the "Памятники" overlay even though they are
  // drawn by the labels layer — unchecking it has to hide the name too, not
  // leave a caption floating where the marker used to be.
  const showMemorials = map.hasLayer(memorialsGroup);

  for (const lp of labelPoints) {
    if (lp.kind === 'memorial' && !showMemorials) continue;
    if (zoom < lp.minZoom) continue;
    if (!bounds.contains(lp.latlng)) continue;
    if (!lp.text) continue;
    if (count >= MAX_LABELS_RENDERED) break;
    count++;
    const className = 'map-label map-label-' + lp.kind + (lp.popupHtml ? ' map-label-clickable' : '');
    const icon = L.divIcon({ className, html: `<span class="label-inner">${escapeHtml(lp.text)}</span>`, iconSize: null });
    const marker = L.marker(lp.latlng, { icon, interactive: !!lp.popupHtml }).addTo(labelsGroup);
    if (lp.popupHtml) marker.bindPopup(lp.popupHtml);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Search ----------
let searchIndex = [];

function buildSearchIndex(data) {
  searchIndex = [];
  const seenStreets = new Set();
  for (const f of data.roads.features) {
    const name = f.properties.name;
    if (!name || seenStreets.has(name)) continue;
    seenStreets.add(name);
    const coords = f.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    searchIndex.push({ label: `Улица ${name}`, sub: '', latlng: L.latLng(mid[1], mid[0]), zoom: 16 });
  }
  for (const f of data.buildings.features) {
    const p = f.properties;
    if (!p.housenumber) continue;
    const c = polygonCentroid(f.geometry.coordinates);
    const label = p.street ? `${p.street}, ${p.housenumber}` : `Дом ${p.housenumber}`;
    searchIndex.push({ label, sub: p.name || '', latlng: c, zoom: 18 });
  }
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!p.name) continue;
    const c = f.geometry.coordinates;
    const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
    searchIndex.push({ label: p.name, sub: [poiLabel(p), addr].filter(Boolean).join(' · '), latlng: L.latLng(c[1], c[0]), zoom: 18 });
  }
  for (const f of data.memorials.features) {
    const p = f.properties;
    const c = f.geometry.coordinates;
    const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
    searchIndex.push({
      label: p.name,
      sub: [memorialTypeLabel(p), addr].filter(Boolean).join(' · '),
      latlng: L.latLng(c[1], c[0]),
      zoom: 18,
    });
  }
}

function normalize(s) {
  // Strip punctuation (commas in "Улица, 39", periods in abbreviations)
  // so "Ломинского 39" matches a label written as "Ломинского, 39".
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Length of the common prefix two words must share to count as the same word
// in different grammatical cases ("Ленину" ~ "Ленин", "Щёлкину" ~ "Щёлкин").
const FUZZY_PREFIX_LEN = 5;
const MAX_SEARCH_RESULTS = 15;

function wordMatches(token, words) {
  return words.some(w => w.includes(token) ||
    (token.length >= FUZZY_PREFIX_LEN && w.length >= FUZZY_PREFIX_LEN &&
      w.slice(0, FUZZY_PREFIX_LEN) === token.slice(0, FUZZY_PREFIX_LEN)));
}

function doSearch(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const qWords = q.split(' ');
  const exact = [];
  const fuzzy = [];
  for (const item of searchIndex) {
    const hay = normalize(item.label + ' ' + item.sub);
    if (hay.includes(q)) {
      exact.push(item);
      if (exact.length >= MAX_SEARCH_RESULTS) break; // fuzzy hits can't make the list anyway
      continue;
    }
    // "памятник Ленину" has to find a monument named just "Ленин" whose type
    // ("Памятник") lives in the subtitle — match word by word instead of as
    // one string, and tolerate Russian case endings.
    if (qWords.length > 1 || q.length >= FUZZY_PREFIX_LEN) {
      const words = hay.split(' ').filter(Boolean);
      if (qWords.every(t => wordMatches(t, words))) fuzzy.push(item);
    }
  }
  return exact.concat(fuzzy).slice(0, MAX_SEARCH_RESULTS);
}

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

let currentResults = [];
let selectedIndex = -1;
let typedQuery = ''; // what the user actually typed, restored on Escape

function selectResult(r) {
  map.setView(r.latlng, r.zoom);
  L.popup().setLatLng(r.latlng).setContent(escapeHtml(r.label)).openOn(map);
  searchResults.style.display = 'none';
  searchInput.value = r.label;
}

// `fillInput`: keyboard navigation substitutes the highlighted result's
// label into the search box (like browser address-bar autocomplete);
// mouse hover only highlights, since hovering isn't an explicit choice.
function setSelected(i, fillInput) {
  const items = searchResults.querySelectorAll('.search-result');
  items.forEach(el => el.classList.remove('search-result-active'));
  selectedIndex = i;
  if (i >= 0 && i < items.length) {
    items[i].classList.add('search-result-active');
    items[i].scrollIntoView({ block: 'nearest' });
    if (fillInput) searchInput.value = currentResults[i].label;
  }
}

function moveSelection(delta) {
  const len = currentResults.length;
  if (!len) return;
  const next = selectedIndex === -1
    ? (delta > 0 ? 0 : len - 1)
    : (selectedIndex + delta + len) % len;
  setSelected(next, true);
}

searchInput.addEventListener('input', () => {
  typedQuery = searchInput.value;
  currentResults = doSearch(typedQuery);
  selectedIndex = -1;
  searchResults.innerHTML = '';
  if (!currentResults.length) {
    searchResults.style.display = 'none';
    return;
  }
  for (const r of currentResults) {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.innerHTML = `<div class="sr-label">${escapeHtml(r.label)}</div>` + (r.sub ? `<div class="sr-sub">${escapeHtml(r.sub)}</div>` : '');
    div.addEventListener('mouseenter', () => setSelected(currentResults.indexOf(r)));
    div.addEventListener('click', () => selectResult(r));
    searchResults.appendChild(div);
  }
  searchResults.style.display = 'block';
});

searchInput.addEventListener('keydown', (e) => {
  if (searchResults.style.display === 'none' || !currentResults.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'Enter') {
    if (selectedIndex >= 0) {
      e.preventDefault();
      selectResult(currentResults[selectedIndex]);
    }
  } else if (e.key === 'Escape') {
    searchResults.style.display = 'none';
    searchInput.value = typedQuery;
  }
});

document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.style.display = 'none';
  }
});

// ---------- Load data and wire everything ----------
Promise.all([
  fetchJSON('data/roads.geojson'),
  fetchJSON('data/buildings.geojson'),
  fetchJSON('data/poi.geojson'),
  fetchJSON('data/landuse.geojson'),
  fetchJSON('data/water.geojson'),
  fetchJSON('data/railway.geojson'),
  fetchJSON('data/addr_nodes.geojson'),
  fetchJSON('data/parking.geojson'),
  fetchJSON('data/memorials.geojson'),
]).then(([roads, buildings, poi, landuse, water, railway, addr_nodes, parking, memorials]) => {
  const data = { roads, buildings, poi, landuse, water, railway, addr_nodes, parking, memorials };
  dataStore = data;
  const { orgIndex, matchedPoiIds } = buildOrgIndex(data);
  const { buildings: buildingsLayer, hybridRoadsGroup } = buildMapLayer(data, orgIndex);
  buildLabelIndex(data, matchedPoiIds, orgIndex);
  buildSearchIndex(data);
  const parkingLayer = buildParkingLayer(data);
  buildMemorialsLayer(data);

  mapLayerGroup.addTo(map);
  buildingsLayer.addTo(map);
  labelsGroup.addTo(map);
  memorialsGroup.addTo(map);
  renderLabels();
  syncMemorialZoom();

  const hybridLayer = L.layerGroup([satelliteLayerHybrid, hybridRoadsGroup]);

  const baseLayers = {
    'Карта': mapLayerGroup,
    'Спутник': satelliteLayer,
    'Гибрид': hybridLayer,
  };
  const overlays = {
    'Названия и объекты': labelsGroup,
    'Памятники': memorialsGroup,
    'Парковки': parkingLayer,
  };
  L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: false }).addTo(map);

  map.on('baselayerchange', (e) => {
    localStorage.setItem('mapMode', e.name);
    satelliteActive = (e.layer === satelliteLayer || e.layer === hybridLayer);
    buildingsLayer.setStyle(buildingStyle);

    // Pure "Спутник" stays a clean photo with nothing overlaid — labels/
    // housenumbers/admin names/memorials belong to "Карта" and "Гибрид".
    // ("Парковки" is off by default, so it stays the user's own choice.)
    const pureSatellite = (e.layer === satelliteLayer);
    const hiddenInSatellite = { 'Названия и объекты': labelsGroup, 'Памятники': memorialsGroup };
    for (const group of Object.values(hiddenInSatellite)) {
      if (pureSatellite && map.hasLayer(group)) map.removeLayer(group);
      else if (!pureSatellite && !map.hasLayer(group)) map.addLayer(group);
    }

    // Leaflet's layers control doesn't reliably resync its checkbox when a
    // layer is toggled outside of a click on that checkbox — fix it up so
    // it doesn't show "checked" for an overlay that isn't actually on the
    // map, and disable it in pure satellite so it can't be forced back on.
    document.querySelectorAll('.leaflet-control-layers-overlays label').forEach(label => {
      const group = hiddenInSatellite[label.textContent.trim()];
      if (!group) return;
      const input = label.querySelector('input');
      input.checked = map.hasLayer(group);
      input.disabled = pureSatellite;
    });
  });

  // Restore the last-used base layer (Карта/Спутник/Гибрид) from localStorage.
  // "Карта" is already active by default, so only act when it differs. Must
  // run after the baselayerchange handler above is registered, since the
  // click below triggers that event synchronously.
  const savedMode = localStorage.getItem('mapMode');
  if (savedMode && savedMode !== 'Карта' && baseLayers[savedMode]) {
    document.querySelectorAll('.leaflet-control-layers-base label').forEach(label => {
      if (label.textContent.trim() !== savedMode) return;
      const input = label.querySelector('input');
      if (input) input.click();
    });
  }

  map.on('moveend zoomend', renderLabels);
  map.on('zoomend', syncMemorialZoom);
  // Toggling "Памятники" in the layers control has to redraw the labels too
  // (see the memorial check in renderLabels).
  map.on('overlayadd overlayremove', renderLabels);

  document.getElementById('loading').style.display = 'none';
}).catch(err => {
  document.getElementById('loading').textContent = 'Ошибка загрузки данных: ' + err.message;
  console.error(err);
});
