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
const satelliteLayer = L.tileLayer('tiles/{z}/{x}/{y}.png', {
  maxZoom: MAX_ZOOM,
  maxNativeZoom: MAX_NATIVE_SAT_ZOOM,
  attribution: 'Esri, Maxar, Earthstar Geographics',
  errorTileUrl: 'lib/images/marker-shadow.png',
});

// ---------- Base layer: vector "map" style ----------
const mapLayerGroup = L.layerGroup();
const landusePane = mapLayerGroup;

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
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!p.name && !p.amenity && !p.shop && !p.office && !p.healthcare && !p.craft && !p.tourism && !p.leisure) continue;
    const [x, y] = f.geometry.coordinates;
    for (const b of buildingBoxes) {
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (pointInRing(x, y, b.ring)) {
        if (!orgIndex.has(b.id)) orgIndex.set(b.id, []);
        orgIndex.get(b.id).push(p);
        break;
      }
    }
  }
  return orgIndex;
}

function buildMapLayer(data, orgIndex) {
  // Landuse
  const landuse = L.geoJSON(data.landuse, {
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
    style: () => ({ color: '#a3ccdb', weight: 1, fillColor: '#aad3df', fillOpacity: 1 }),
  });
  water.addTo(mapLayerGroup);

  // Railway
  const railway = L.geoJSON(data.railway, {
    style: () => ({ color: '#8a8a8a', weight: 2, dashArray: '1,6' }),
  });
  railway.addTo(mapLayerGroup);

  // Roads - casing pass then center pass for nicer look
  const roadsCasing = L.geoJSON(data.roads, {
    style: f => {
      const s = roadStyle(f);
      if (!s.casing) return { opacity: 0 };
      return { color: s.casing, weight: s.weight + 1.6, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    },
  });
  roadsCasing.addTo(mapLayerGroup);

  const roadsCenter = L.geoJSON(data.roads, {
    style: f => {
      const s = roadStyle(f);
      return {
        color: s.color,
        weight: s.weight,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray: s.dashed ? '4,4' : null,
      };
    },
  });
  roadsCenter.addTo(mapLayerGroup);

  // Buildings
  const buildings = L.geoJSON(data.buildings, {
    style: () => ({ color: '#c4b9a8', weight: 1, fillColor: '#d9d0c4', fillOpacity: 0.95 }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const orgs = orgIndex.get(p.id) || [];
      const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
      if (!p.name && !addr && !orgs.length) return;
      let html = '';
      if (p.name) html += `<b>${escapeHtml(p.name)}</b><br>`;
      if (addr) html += `${escapeHtml(addr)}<br>`;
      if (orgs.length) {
        html += '<div class="building-orgs">' + orgs.map(o => {
          const cat = poiLabel(o);
          const title = o.name || cat || 'организация';
          return `<div class="org-item"><b>${escapeHtml(title)}</b>` +
            (o.name && cat ? ` <span class="org-cat">(${escapeHtml(cat)})</span>` : '') +
            '</div>';
        }).join('') + '</div>';
      }
      layer.bindPopup(html);
    },
  });
  buildings.addTo(mapLayerGroup);
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

function polygonCentroid(coords) {
  // coords: [ [ [lon,lat], ... ] ] (outer ring only, simple average)
  const ring = coords[0];
  let x = 0, y = 0;
  for (const c of ring) { x += c[0]; y += c[1]; }
  const n = ring.length;
  return L.latLng(y / n, x / n);
}

function buildLabelIndex(data) {
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
const STREET_LABEL_MIN_ZOOM = 15;
const STREET_LABEL_STEP_PX = 260; // spacing between repeated labels along a long street
const STREET_LABEL_MIN_LEN_PX = 40; // skip streets too short to fit a label

function addStreetLabels(zoom, bounds, budget) {
  let count = 0;
  for (const street of namedStreets) {
    if (count >= budget) break;
    if (!bounds.intersects(street.bounds)) continue;

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
  return s.toLowerCase().replace(/ё/g, 'е');
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
  const orgIndex = buildOrgIndex(data);
  buildMapLayer(data, orgIndex);
  buildLabelIndex(data);
  buildSearchIndex(data);
  const parkingLayer = buildParkingLayer(data);

  mapLayerGroup.addTo(map);
  labelsGroup.addTo(map);
  renderLabels();

  const baseLayers = {
    'Карта': mapLayerGroup,
    'Спутник': satelliteLayer,
  };
  const overlays = {
    'Названия и объекты': labelsGroup,
    'Парковки': parkingLayer,
  };
  L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: false }).addTo(map);

  map.on('moveend zoomend', renderLabels);

  document.getElementById('loading').style.display = 'none';
}).catch(err => {
  document.getElementById('loading').textContent = 'Ошибка загрузки данных: ' + err.message;
  console.error(err);
});
