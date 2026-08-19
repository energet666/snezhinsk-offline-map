// "Названия и объекты" overlay: house numbers, street names, admin/social
// building captions, stadium and monument names.
//
// Two stages. buildLabelIndex() runs once after load and turns the data into
// a flat list of candidate labels; renderLabels() runs on every move/zoom and
// draws the subset that is currently visible. Labels are markers with a
// divIcon, re-created from scratch on each render.
import {
  ADMIN_LABEL_MIN_ZOOM, HOUSENUMBER_DEDUPE_METERS, HOUSENUMBER_LABEL_MIN_ZOOM,
  MAX_LABELS_RENDERED, MEMORIAL_LABEL_MIN_ZOOM,
  STREET_LABEL_MIN_LEN_PX, STREET_LABEL_MIN_ZOOM, STREET_LABEL_STEP_PX,
} from './config.js';
import { buildingRingIndex, entryContains, polygonCentroid } from './geo.js';
import { map } from './map.js';
import { memorialsGroup } from './memorials.js';
import { escapeHtml, standalonePoiPopupHtml } from './popups.js';
import { adminBuildingLabel, isPlaque, memorialLabel, stadiumLabel } from './tagstyles.js';

export const labelsGroup = L.layerGroup();

let labelPoints = []; // {latlng, text, minZoom, kind, below?, popupHtml?}
let namedStreets = []; // {name, latlngs, bounds} - rendered along the road itself

// ---------- Index ----------

export function buildLabelIndex(data, matchedPoiIds, orgIndex) {
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

  // Buildings that get a name/type caption below (Школа 122, Новый Снежинск, …)
  // put it on the very same centroid as their house number, so the number ends
  // up hidden underneath the name. Collect them here and shift the number down.
  const namedBuildingIds = new Set();
  for (const f of data.buildings.features) {
    const p = f.properties;
    const orgs = orgIndex.get(p.id) || [];
    if (adminBuildingLabel(p) || orgs.some(o => adminBuildingLabel(o))) namedBuildingIds.add(p.id);
  }

  // House number labels
  for (const f of data.buildings.features) {
    if (!f.properties.housenumber) continue;
    labelPoints.push({
      latlng: polygonCentroid(f.geometry.coordinates),
      text: f.properties.housenumber,
      minZoom: HOUSENUMBER_LABEL_MIN_ZOOM,
      kind: 'housenumber',
      below: namedBuildingIds.has(f.properties.id),
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
  const addressedBuildings = buildingRingIndex(
    data.buildings.features.filter(f => f.properties.housenumber));
  for (const f of data.addr_nodes.features) {
    if (!f.properties.housenumber) continue;
    const [x, y] = f.geometry.coordinates;
    if (addressedBuildings.some(b => entryContains(b, x, y))) continue;
    labelPoints.push({
      latlng: L.latLng(y, x),
      text: f.properties.housenumber,
      minZoom: HOUSENUMBER_LABEL_MIN_ZOOM,
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
    const dup = kept.some(k => k.kind === 'housenumber' && k.text === lp.text &&
      map.distance(k.latlng, lp.latlng) < HOUSENUMBER_DEDUPE_METERS);
    if (!dup) kept.push(lp);
  }
  labelPoints = kept;
}

// ---------- Render ----------

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

export function renderLabels() {
  labelsGroup.clearLayers();

  // Nothing to draw when the overlay is off — and drawing anyway used to
  // leave orphaned labels on the map. Leaflet nulls `layer._map` only *after*
  // it fires `layerremove`, and this function runs as an `overlayremove`
  // listener: at that moment labelsGroup still points at the map, so every
  // marker added below went straight into the DOM and stayed there, with
  // nothing left to remove it. Result: captions floating over pure satellite
  // imagery, and a fresh set of them piling up on every base-layer switch.
  if (!map.hasLayer(labelsGroup)) return;

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
    const className = 'map-label map-label-' + lp.kind
      + (lp.popupHtml ? ' map-label-clickable' : '')
      + (lp.below ? ' map-label-below' : '');
    const icon = L.divIcon({ className, html: `<span class="label-inner">${escapeHtml(lp.text)}</span>`, iconSize: null });
    const marker = L.marker(lp.latlng, { icon, interactive: !!lp.popupHtml }).addTo(labelsGroup);
    if (lp.popupHtml) marker.bindPopup(lp.popupHtml);
  }
}
