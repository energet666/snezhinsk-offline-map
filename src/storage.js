// Everything the app remembers between visits: map position, base layer and
// overlay checkboxes. All reads tolerate missing/corrupted values and fall
// back to the defaults — localStorage is user-writable and survives across
// versions of the app.
import { OVERLAY_DEFAULTS, STORAGE_KEYS } from './config.js';

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) { /* malformed/absent — caller falls back to a default */ }
  return null;
}

// Restore the last-viewed map position/zoom so a page refresh lands exactly
// where the user left off, instead of always resetting to CITY_CENTER.
export function getSavedView() {
  const v = readJSON(STORAGE_KEYS.view);
  if (v && Array.isArray(v.center) && v.center.length === 2 && typeof v.zoom === 'number') return v;
  return null;
}

export function saveView(center, zoom) {
  localStorage.setItem(STORAGE_KEYS.view, JSON.stringify({ center, zoom }));
}

export function getSavedMode() {
  return localStorage.getItem(STORAGE_KEYS.mode);
}

export function saveMode(name) {
  localStorage.setItem(STORAGE_KEYS.mode, name);
}

// The overlay checkboxes are a user setting just like the base layer and the
// map view, so they survive a reload too. Missing/новые keys fall back to the
// defaults, so adding an overlay later doesn't need a storage migration.
export function getOverlayPrefs() {
  const v = readJSON(STORAGE_KEYS.overlays);
  if (v && typeof v === 'object') return Object.assign({}, OVERLAY_DEFAULTS, v);
  return Object.assign({}, OVERLAY_DEFAULTS);
}

export function saveOverlayPrefs(prefs) {
  localStorage.setItem(STORAGE_KEYS.overlays, JSON.stringify(prefs));
}
