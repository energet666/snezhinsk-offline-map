const CITY_CENTER = [56.0870090, 60.7326740];
const INITIAL_ZOOM = 14;
const MAX_ZOOM = 19;
const MAX_NATIVE_SAT_ZOOM = 17;

const map = L.map('map', {
  center: CITY_CENTER,
  zoom: INITIAL_ZOOM,
  maxZoom: MAX_ZOOM,
  zoomControl: false,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);

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
          let details = '';
          if (o.phone) details += `<div class="org-detail">☎ ${escapeHtml(o.phone)}</div>`;
          if (o.opening_hours) {
            const days = o.opening_hours.split('; ').map(d => `<div>${escapeHtml(d)}</div>`).join('');
            details += `<div class="org-detail org-hours">🕑<div class="org-hours-days">${days}</div></div>`;
          }
          if (o.website) details += `<div class="org-detail"><a href="${escapeHtml(o.website)}" target="_blank" rel="noopener">${escapeHtml(o.website)}</a></div>`;
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

function buildLabelIndex(data, matchedPoiIds) {
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
  // Most carry no `name` in OSM, so fall back to a generic type label.
  for (const f of data.buildings.features) {
    const p = f.properties;
    const generic = adminBuildingLabel(p);
    if (!generic) continue;
    labelPoints.push({
      latlng: polygonCentroid(f.geometry.coordinates),
      text: p.name || generic,
      minZoom: ADMIN_LABEL_MIN_ZOOM,
      kind: 'admin',
    });
  }

  // Same admin labeling for standalone POIs (e.g. школа 135, tagged as a
  // point with no enclosing building at all in OSM) — skip ones already
  // surfaced via a building popup (buildOrgIndex) to avoid double-labeling.
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

  for (const f of data.addr_nodes.features) {
    if (!f.properties.housenumber) continue;
    const c = f.geometry.coordinates;
    labelPoints.push({
      latlng: L.latLng(c[1], c[0]),
      text: f.properties.housenumber,
      minZoom: 17,
      kind: 'housenumber',
    });
  }

  // Note: organizations are intentionally not shown as always-on labels —
  // they surface via a click on their building (see buildMapLayer) or search.
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

  for (const lp of labelPoints) {
    if (zoom < lp.minZoom) continue;
    if (!bounds.contains(lp.latlng)) continue;
    if (!lp.text) continue;
    if (count >= MAX_LABELS_RENDERED) break;
    count++;
    const className = 'map-label map-label-' + lp.kind;
    const icon = L.divIcon({ className, html: `<span class="label-inner">${escapeHtml(lp.text)}</span>`, iconSize: null });
    L.marker(lp.latlng, { icon, interactive: false }).addTo(labelsGroup);
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
}

function normalize(s) {
  // Strip punctuation (commas in "Улица, 39", periods in abbreviations)
  // so "Ломинского 39" matches a label written as "Ломинского, 39".
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function doSearch(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const results = [];
  for (const item of searchIndex) {
    if (normalize(item.label).includes(q) || normalize(item.sub).includes(q)) {
      results.push(item);
      if (results.length >= 15) break;
    }
  }
  return results;
}

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

searchInput.addEventListener('input', () => {
  const results = doSearch(searchInput.value);
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.style.display = 'none';
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.innerHTML = `<div class="sr-label">${escapeHtml(r.label)}</div>` + (r.sub ? `<div class="sr-sub">${escapeHtml(r.sub)}</div>` : '');
    div.addEventListener('click', () => {
      map.setView(r.latlng, r.zoom);
      L.popup().setLatLng(r.latlng).setContent(escapeHtml(r.label)).openOn(map);
      searchResults.style.display = 'none';
      searchInput.value = r.label;
    });
    searchResults.appendChild(div);
  }
  searchResults.style.display = 'block';
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
]).then(([roads, buildings, poi, landuse, water, railway, addr_nodes, parking]) => {
  const data = { roads, buildings, poi, landuse, water, railway, addr_nodes, parking };
  dataStore = data;
  const { orgIndex, matchedPoiIds } = buildOrgIndex(data);
  const { buildings: buildingsLayer, hybridRoadsGroup } = buildMapLayer(data, orgIndex);
  buildLabelIndex(data, matchedPoiIds);
  buildSearchIndex(data);
  const parkingLayer = buildParkingLayer(data);

  mapLayerGroup.addTo(map);
  buildingsLayer.addTo(map);
  labelsGroup.addTo(map);
  renderLabels();

  const hybridLayer = L.layerGroup([satelliteLayerHybrid, hybridRoadsGroup]);

  const baseLayers = {
    'Карта': mapLayerGroup,
    'Спутник': satelliteLayer,
    'Гибрид': hybridLayer,
  };
  const overlays = {
    'Названия и объекты': labelsGroup,
    'Парковки': parkingLayer,
  };
  L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: false }).addTo(map);

  map.on('baselayerchange', (e) => {
    localStorage.setItem('mapMode', e.name);
    satelliteActive = (e.layer === satelliteLayer || e.layer === hybridLayer);
    buildingsLayer.setStyle(buildingStyle);

    // Pure "Спутник" stays a clean photo with nothing overlaid — labels/
    // housenumbers/admin names belong to "Карта" and "Гибрид" instead.
    const pureSatellite = (e.layer === satelliteLayer);
    if (pureSatellite && map.hasLayer(labelsGroup)) map.removeLayer(labelsGroup);
    else if (!pureSatellite && !map.hasLayer(labelsGroup)) map.addLayer(labelsGroup);

    // Leaflet's layers control doesn't reliably resync its checkbox when a
    // layer is toggled outside of a click on that checkbox — fix it up so
    // it doesn't show "checked" for an overlay that isn't actually on the
    // map, and disable it in pure satellite so it can't be forced back on.
    document.querySelectorAll('.leaflet-control-layers-overlays label').forEach(label => {
      if (label.textContent.trim() !== 'Названия и объекты') return;
      const input = label.querySelector('input');
      input.checked = map.hasLayer(labelsGroup);
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

  document.getElementById('loading').style.display = 'none';
}).catch(err => {
  document.getElementById('loading').textContent = 'Ошибка загрузки данных: ' + err.message;
  console.error(err);
});
