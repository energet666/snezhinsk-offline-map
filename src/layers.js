// Base layers (satellite imagery and the vector "Карта" style) plus the
// parking overlay.
import {
  HYBRID_ROAD_OPACITY, LANDUSE_PANE, LANDUSE_PANE_Z_INDEX,
  MAX_NATIVE_SAT_ZOOM, MAX_ZOOM,
} from './config.js';
import { map } from './map.js';
import { buildingPopupHtml, parkingPopupHtml } from './popups.js';
import {
  BUILDING_STYLE, PARKING_STYLE, RAILWAY_STYLE, WATER_STYLE,
  isGarage, landuseColor, roadStyle,
} from './tagstyles.js';

// ---------- Base layer: satellite (local Esri tiles) ----------
const SATELLITE_TILE_OPTS = {
  maxZoom: MAX_ZOOM,
  maxNativeZoom: MAX_NATIVE_SAT_ZOOM,
  attribution: 'Esri, Maxar, Earthstar Geographics',
  errorTileUrl: 'lib/images/marker-shadow.png',
};
export const satelliteLayer = L.tileLayer('tiles/{z}/{x}/{y}.png', SATELLITE_TILE_OPTS);
// A second, independent tile layer for "Гибрид" (same local tiles, served
// from the browser cache) — reusing satelliteLayer itself as a child of the
// hybrid layer group would make map.hasLayer(satelliteLayer) true whenever
// either base layer is active. Leaflet's layers control re-syncs ALL of its
// inputs on every click inside the control, not just the one clicked, so
// toggling e.g. "Названия и объекты" while in Гибрид would see the
// "Спутник" radio unchecked but hasLayer(satelliteLayer) true, read that as
// a mismatch, and remove the (shared) tile layer — the imagery would vanish
// even though Гибрид was still selected.
export const satelliteLayerHybrid = L.tileLayer('tiles/{z}/{x}/{y}.png', SATELLITE_TILE_OPTS);

// ---------- Base layer: vector "map" style ----------
export const mapLayerGroup = L.layerGroup();

// Buildings live outside the swappable base layer so their click popups
// keep working in satellite/hybrid mode too — just invisible there.
let satelliteActive = false;

export function setSatelliteActive(active) {
  satelliteActive = active;
}

export function buildingStyle(feature) {
  if (satelliteActive) return BUILDING_STYLE.hidden;
  return isGarage(feature) ? BUILDING_STYLE.garage : BUILDING_STYLE.normal;
}

// Roads: casing pass then center pass for nicer look. Built twice — full
// opacity for the "Карта" base layer, and a dimmer copy (see
// HYBRID_ROAD_OPACITY) for the separate "Гибрид" base layer, which lays
// roads over the satellite photo instead of replacing it.
function buildRoadLayers(roads, opacity) {
  const group = L.layerGroup();
  L.geoJSON(roads, {
    pane: LANDUSE_PANE,
    style: f => {
      const s = roadStyle(f);
      if (!s.casing) return { opacity: 0 };
      return { color: s.casing, weight: s.weight + 1.6, opacity, lineCap: 'round', lineJoin: 'round' };
    },
  }).addTo(group);
  L.geoJSON(roads, {
    pane: LANDUSE_PANE,
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

function buildBuildingsLayer(data, orgIndex) {
  return L.geoJSON(data.buildings, {
    style: buildingStyle,
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const orgs = orgIndex.get(p.id) || [];
      const html = buildingPopupHtml(p, orgs);
      if (!html) {
        if (isGarage(f)) layer.bindPopup('Гараж');
        return;
      }
      layer.bindPopup(html);
      // The per-organization details start hidden (see buildingPopupHtml) —
      // clicking an org name toggles its own panel.
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
}

export function buildMapLayer(data, orgIndex) {
  map.createPane(LANDUSE_PANE);
  map.getPane(LANDUSE_PANE).style.zIndex = LANDUSE_PANE_Z_INDEX;

  L.geoJSON(data.landuse, {
    pane: LANDUSE_PANE,
    style: f => ({ color: 'none', weight: 0, fillColor: landuseColor(f), fillOpacity: 0.9 }),
  }).addTo(mapLayerGroup);

  L.geoJSON(data.water, { pane: LANDUSE_PANE, style: () => WATER_STYLE }).addTo(mapLayerGroup);
  L.geoJSON(data.railway, { pane: LANDUSE_PANE, style: () => RAILWAY_STYLE }).addTo(mapLayerGroup);

  buildRoadLayers(data.roads, 1).addTo(mapLayerGroup);
  const hybridRoadsGroup = buildRoadLayers(data.roads, HYBRID_ROAD_OPACITY);

  // Buildings — not added to mapLayerGroup, see buildingStyle() above
  const buildings = buildBuildingsLayer(data, orgIndex);
  return { buildings, hybridRoadsGroup };
}

// ---------- Parking overlay (separate checkbox) ----------
export function buildParkingLayer(data) {
  return L.geoJSON(data.parking, {
    style: () => ({ color: PARKING_STYLE.border, weight: 1, fillColor: PARKING_STYLE.fill, fillOpacity: 0.85 }),
    pointToLayer: (f, latlng) => L.marker(latlng, {
      icon: L.divIcon({ className: 'parking-marker', html: 'P', iconSize: [18, 18] }),
    }),
    onEachFeature: (f, layer) => layer.bindPopup(parkingPopupHtml(f.properties)),
  });
}
