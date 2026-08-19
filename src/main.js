// Entry point: load the data files, build every layer, wire the controls.
import { BASE_LAYER_NAMES, OVERLAY_NAMES } from './config.js';
import { buildLabelIndex, labelsGroup, renderLabels } from './labels.js';
import {
  buildMapLayer, buildParkingLayer, buildingStyle, mapLayerGroup,
  satelliteLayer, satelliteLayerHybrid, setSatelliteActive,
} from './layers.js';
import { map } from './map.js';
import { buildMemorialsLayer, memorialsGroup, syncMemorialZoom } from './memorials.js';
import { buildOrgIndex } from './orgindex.js';
import { buildSearchIndex, initSearchUI } from './search.js';
import { getOverlayPrefs, getSavedMode, saveMode, saveOverlayPrefs } from './storage.js';

// Every data/<name>.geojson the app needs; the loaded objects end up in
// `data` under exactly these keys.
const DATA_LAYERS = [
  'roads', 'buildings', 'poi', 'landuse', 'water',
  'railway', 'addr_nodes', 'parking', 'memorials',
];

function fetchJSON(path) {
  return fetch(path).then(r => {
    if (!r.ok) throw new Error('failed to load ' + path);
    return r.json();
  });
}

function loadData() {
  return Promise.all(DATA_LAYERS.map(name => fetchJSON(`data/${name}.geojson`)))
    .then(loaded => Object.fromEntries(DATA_LAYERS.map((name, i) => [name, loaded[i]])));
}

// The search box works (with an empty index) before the data arrives, just
// as it did when everything lived in one script.
initSearchUI();

loadData().then(data => {
  const { orgIndex, matchedPoiIds } = buildOrgIndex(data);
  const { buildings: buildingsLayer, hybridRoadsGroup } = buildMapLayer(data, orgIndex);
  buildLabelIndex(data, matchedPoiIds, orgIndex);
  buildSearchIndex(data);
  const parkingLayer = buildParkingLayer(data);
  buildMemorialsLayer(data);

  mapLayerGroup.addTo(map);
  buildingsLayer.addTo(map);

  const hybridLayer = L.layerGroup([satelliteLayerHybrid, hybridRoadsGroup]);

  const baseLayers = {
    [BASE_LAYER_NAMES.map]: mapLayerGroup,
    [BASE_LAYER_NAMES.satellite]: satelliteLayer,
    [BASE_LAYER_NAMES.hybrid]: hybridLayer,
  };
  const overlays = {
    [OVERLAY_NAMES.labels]: labelsGroup,
    [OVERLAY_NAMES.memorials]: memorialsGroup,
    [OVERLAY_NAMES.parking]: parkingLayer,
  };

  const overlayPrefs = getOverlayPrefs();

  // Set to true around the programmatic toggles the satellite mode does on its
  // own — those aren't the user's choice and must not overwrite the saved prefs.
  let applyingOverlayPrefs = false;
  function rememberOverlayPrefs() {
    if (applyingOverlayPrefs) return;
    for (const [name, group] of Object.entries(overlays)) overlayPrefs[name] = map.hasLayer(group);
    saveOverlayPrefs(overlayPrefs);
  }

  // Applied before the layers control is created, so its checkboxes render
  // already matching the restored state.
  for (const [name, group] of Object.entries(overlays)) {
    if (overlayPrefs[name]) map.addLayer(group);
  }
  renderLabels();
  syncMemorialZoom();

  L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: false }).addTo(map);
  map.on('overlayadd overlayremove', rememberOverlayPrefs);

  map.on('baselayerchange', (e) => {
    saveMode(e.name);
    setSatelliteActive(e.layer === satelliteLayer || e.layer === hybridLayer);
    buildingsLayer.setStyle(buildingStyle);

    // Pure "Спутник" stays a clean photo with nothing overlaid — labels/
    // housenumbers/admin names/memorials belong to "Карта" and "Гибрид".
    // ("Парковки" is off by default, so it stays the user's own choice.)
    const pureSatellite = (e.layer === satelliteLayer);
    const hiddenInSatellite = {
      [OVERLAY_NAMES.labels]: labelsGroup,
      [OVERLAY_NAMES.memorials]: memorialsGroup,
    };
    applyingOverlayPrefs = true;
    for (const [name, group] of Object.entries(hiddenInSatellite)) {
      // Leaving pure satellite restores what the user actually had checked,
      // not a blanket "on" — otherwise switching modes would silently undo it.
      const shouldShow = !pureSatellite && overlayPrefs[name];
      if (shouldShow && !map.hasLayer(group)) map.addLayer(group);
      else if (!shouldShow && map.hasLayer(group)) map.removeLayer(group);
    }
    applyingOverlayPrefs = false;

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
  const savedMode = getSavedMode();
  if (savedMode && savedMode !== BASE_LAYER_NAMES.map && baseLayers[savedMode]) {
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

  // Module scope is not global scope — expose the loaded data for the browser
  // console and Playwright checks (the map itself is exposed in map.js).
  window.mapData = data;

  document.getElementById('loading').style.display = 'none';
}).catch(err => {
  document.getElementById('loading').textContent = 'Ошибка загрузки данных: ' + err.message;
  console.error(err);
});
