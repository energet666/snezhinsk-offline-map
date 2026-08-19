// The single Leaflet map instance. Lives in its own module because almost
// every other module needs it (project/unproject, zoom, hasLayer), and a
// module import is a far clearer dependency than a global.
// Leaflet itself is still a plain global `L` — it's loaded from lib/ as a
// classic script, not as a module.
import { CITY_CENTER, INITIAL_ZOOM, MAX_ZOOM } from './config.js';
import { getSavedView, saveView } from './storage.js';

const savedView = getSavedView();

export const map = L.map('map', {
  center: savedView ? savedView.center : CITY_CENTER,
  zoom: savedView ? savedView.zoom : INITIAL_ZOOM,
  maxZoom: MAX_ZOOM,
  zoomControl: false,
});

L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);

map.on('moveend', () => {
  const c = map.getCenter();
  saveView([c.lat, c.lng], map.getZoom());
});

// Module scope is not global scope: `map` used to be a top-level variable of
// app.js and both the browser console and the Playwright checks (see
// CLAUDE.md) reach for it by name — keep it reachable.
window.map = map;
