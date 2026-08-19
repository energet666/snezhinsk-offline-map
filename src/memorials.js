// "Памятники" overlay: monuments/sculptures and wall plaques.
// Markers are built once and kept, rather than re-created on every move like
// the labels are: re-creating them would close an open popup as soon as
// Leaflet pans the map to fit that popup. Zoom filtering is done by adding /
// removing the whole plaques sub-group instead.
import { MEMORIAL_MONUMENT_MIN_ZOOM, MEMORIAL_PLAQUE_MIN_ZOOM } from './config.js';
import { map } from './map.js';
import { memorialPopupHtml } from './popups.js';
import { isPlaque } from './tagstyles.js';

export const memorialsGroup = L.layerGroup();
const monumentMarkers = L.layerGroup();
const plaqueMarkers = L.layerGroup();

export function buildMemorialsLayer(data) {
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
    marker.bindPopup(memorialPopupHtml(p));
    marker.addTo(plaque ? plaqueMarkers : monumentMarkers);
  }
}

function syncSubGroup(subGroup, show) {
  if (show && !memorialsGroup.hasLayer(subGroup)) memorialsGroup.addLayer(subGroup);
  else if (!show && memorialsGroup.hasLayer(subGroup)) memorialsGroup.removeLayer(subGroup);
}

// Plaques only from MEMORIAL_PLAQUE_MIN_ZOOM up — at city zoom they'd bury
// the monuments under a cloud of near-identical dots on the same few streets.
export function syncMemorialZoom() {
  const zoom = map.getZoom();
  syncSubGroup(plaqueMarkers, zoom >= MEMORIAL_PLAQUE_MIN_ZOOM);
  syncSubGroup(monumentMarkers, zoom >= MEMORIAL_MONUMENT_MIN_ZOOM);
}
