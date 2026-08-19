// Numbers that tune how the map looks and behaves. Kept in one place so a
// threshold can be found and changed without reading the layer code.

// ---------- View ----------
export const CITY_CENTER = [56.0870090, 60.7326740];
export const INITIAL_ZOOM = 14;
export const MAX_ZOOM = 19;
// Highest zoom level actually present in tiles/ — above it Leaflet upscales.
export const MAX_NATIVE_SAT_ZOOM = 17;

// ---------- Base layers ----------
// Landuse/roads/water get their own pane, pinned below the default
// overlayPane (where buildings live) via z-index. Without this, toggling
// Карта -> Спутник -> Карта removes and re-adds mapLayerGroup, and Leaflet's
// SVG renderer re-appends its paths at the end of the shared <svg> — after
// the buildings paths, which never left the DOM — so the landuse polygons
// end up stacked on top of buildings instead of under them.
export const LANDUSE_PANE = 'landusePane';
export const LANDUSE_PANE_Z_INDEX = 350;
// Roads drawn over the satellite photo in "Гибрид" are dimmed so the imagery
// underneath stays readable.
export const HYBRID_ROAD_OPACITY = 0.55;

// ---------- Labels ----------
export const MAX_LABELS_RENDERED = 400;
export const HOUSENUMBER_LABEL_MIN_ZOOM = 17;
export const ADMIN_LABEL_MIN_ZOOM = 17;
export const STREET_LABEL_MIN_ZOOM = 15;
export const STREET_LABEL_STEP_PX = 260; // spacing between repeated labels along a long street
export const STREET_LABEL_MIN_LEN_PX = 40; // skip streets too short to fit a label
// Two housenumber labels with the same text closer than this are the same
// address coming from two sources (see dedupeHousenumberLabels).
export const HOUSENUMBER_DEDUPE_METERS = 20;

// ---------- Memorials ----------
// Plaques are both numerous (48 vs 19) and only interesting up close, so they
// appear later and never get an always-on map label — only a marker + popup.
export const MEMORIAL_MONUMENT_MIN_ZOOM = 14;
export const MEMORIAL_PLAQUE_MIN_ZOOM = 17;
export const MEMORIAL_LABEL_MIN_ZOOM = 16;
export const MEMORIAL_LABEL_MAX_CHARS = 30;

// ---------- Search ----------
// Length of the common prefix two words must share to count as the same word
// in different grammatical cases ("Ленину" ~ "Ленин", "Щёлкину" ~ "Щёлкин").
export const FUZZY_PREFIX_LEN = 5;
export const MAX_SEARCH_RESULTS = 15;

// ---------- Layer names / persistence ----------
export const BASE_LAYER_NAMES = { map: 'Карта', satellite: 'Спутник', hybrid: 'Гибрид' };
export const OVERLAY_NAMES = {
  labels: 'Названия и объекты',
  memorials: 'Памятники',
  parking: 'Парковки',
};
export const OVERLAY_DEFAULTS = {
  [OVERLAY_NAMES.labels]: true,
  [OVERLAY_NAMES.memorials]: true,
  [OVERLAY_NAMES.parking]: false,
};

export const STORAGE_KEYS = {
  view: 'mapView',
  mode: 'mapMode',
  overlays: 'mapOverlays',
};
