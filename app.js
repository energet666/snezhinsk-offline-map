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

function buildMapLayer(data) {
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
      if (p.name || p.housenumber) {
        const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
        layer.bindTooltip([p.name, addr].filter(Boolean).join(' — '), { sticky: true });
      }
    },
  });
  buildings.addTo(mapLayerGroup);
}

// ---------- Labels overlay (works on top of both base modes, like Google hybrid) ----------
const labelsGroup = L.layerGroup();
let labelPoints = []; // {latlng, text, minZoom, kind}

function polylineMidpoint(latlngs) {
  const flat = Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs;
  const pts = Array.isArray(latlngs[0]) ? latlngs : latlngs;
  const arr = pts;
  const mid = arr[Math.floor(arr.length / 2)];
  return mid;
}

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

  // Street name labels (roads with a name)
  for (const f of data.roads.features) {
    if (!f.properties.name) continue;
    const coords = f.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    labelPoints.push({
      latlng: L.latLng(mid[1], mid[0]),
      text: f.properties.name,
      minZoom: 15,
      kind: 'street',
    });
  }

  // House number labels
  for (const f of data.buildings.features) {
    if (!f.properties.housenumber) continue;
    const c = polygonCentroid(f.geometry.coordinates);
    labelPoints.push({
      latlng: c,
      text: f.properties.housenumber,
      minZoom: 18,
      kind: 'housenumber',
    });
  }
  for (const f of data.addr_nodes.features) {
    if (!f.properties.housenumber) continue;
    const c = f.geometry.coordinates;
    labelPoints.push({
      latlng: L.latLng(c[1], c[0]),
      text: f.properties.housenumber,
      minZoom: 18,
      kind: 'housenumber',
    });
  }

  // POI markers
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!p.name && !p.amenity && !p.shop && !p.office) continue;
    const c = f.geometry.coordinates;
    labelPoints.push({
      latlng: L.latLng(c[1], c[0]),
      text: p.name || poiLabel(p),
      minZoom: 16,
      kind: 'poi',
      color: poiColor(p),
      props: p,
    });
  }
}

const MAX_LABELS_RENDERED = 400;

function renderLabels() {
  labelsGroup.clearLayers();
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  let count = 0;
  for (const lp of labelPoints) {
    if (zoom < lp.minZoom) continue;
    if (!bounds.contains(lp.latlng)) continue;
    if (!lp.text) continue;
    if (count >= MAX_LABELS_RENDERED) break;
    count++;
    let className = 'map-label map-label-' + lp.kind;
    let html;
    if (lp.kind === 'poi') {
      html = `<span class="poi-dot" style="background:${lp.color}"></span><span class="poi-text">${escapeHtml(lp.text)}</span>`;
    } else {
      html = escapeHtml(lp.text);
    }
    const icon = L.divIcon({ className, html, iconSize: null });
    const marker = L.marker(lp.latlng, { icon, interactive: lp.kind === 'poi' });
    if (lp.kind === 'poi' && lp.props) {
      const p = lp.props;
      const addr = [p.street, p.housenumber].filter(Boolean).join(', ');
      marker.bindPopup(`<b>${escapeHtml(p.name || poiLabel(p))}</b><br>${escapeHtml(poiLabel(p))}${addr ? '<br>' + escapeHtml(addr) : ''}`);
    }
    marker.addTo(labelsGroup);
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
]).then(([roads, buildings, poi, landuse, water, railway, addr_nodes]) => {
  const data = { roads, buildings, poi, landuse, water, railway, addr_nodes };
  dataStore = data;
  buildMapLayer(data);
  buildLabelIndex(data);
  buildSearchIndex(data);

  mapLayerGroup.addTo(map);
  labelsGroup.addTo(map);
  renderLabels();

  const baseLayers = {
    'Карта': mapLayerGroup,
    'Спутник': satelliteLayer,
  };
  const overlays = {
    'Названия и объекты': labelsGroup,
  };
  L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: false }).addTo(map);

  map.on('moveend zoomend', renderLabels);

  document.getElementById('loading').style.display = 'none';
}).catch(err => {
  document.getElementById('loading').textContent = 'Ошибка загрузки данных: ' + err.message;
  console.error(err);
});
