// Styling rules mapping OSM tags (and 2GIS categories) to a Google-Maps-like
// look and to Russian labels. Pure lookup tables — no Leaflet, no DOM.
import { MEMORIAL_LABEL_MAX_CHARS } from './config.js';

const ROAD_STYLES = {
  motorway:      { color: '#f0a95e', weight: 7, casing: '#d98a3d' },
  trunk:         { color: '#f0a95e', weight: 6, casing: '#d98a3d' },
  primary:       { color: '#fcd6a4', weight: 6, casing: '#e0a86a' },
  secondary:     { color: '#fef2b3', weight: 5, casing: '#d9c26a' },
  tertiary:      { color: '#ffffff', weight: 4, casing: '#c9b98a' },
  unclassified:  { color: '#ffffff', weight: 3, casing: '#c8c8c8' },
  residential:   { color: '#ffffff', weight: 3, casing: '#c8c8c8' },
  living_street: { color: '#f2f2f2', weight: 3, casing: '#c8c8c8' },
  service:       { color: '#ffffff', weight: 2, casing: '#d0d0d0' },
  pedestrian:    { color: '#dedede', weight: 3, casing: '#bdbdbd' },
  footway:       { color: '#e5b3d6', weight: 2, casing: null, dashed: true },
  path:          { color: '#c5a880', weight: 1.5, casing: null, dashed: true },
  track:         { color: '#c5a880', weight: 1.5, casing: null, dashed: true },
  cycleway:      { color: '#a3d9c9', weight: 1.5, casing: null, dashed: true },
  steps:         { color: '#e5b3d6', weight: 2, casing: null, dashed: true },
};
const ROAD_DEFAULT = { color: '#ffffff', weight: 2, casing: '#d0d0d0' };

export function roadStyle(feature) {
  const hw = feature.properties.highway;
  const s = ROAD_STYLES[hw] || ROAD_DEFAULT;
  return s;
}

const LANDUSE_COLORS = {
  residential: '#e9e6e1',
  industrial: '#ead9d9',
  commercial: '#e8d9e0',
  retail: '#ecd9d9',
  forest: '#c8e0b4',
  natural_wood: '#c8e0b4',
  grass: '#cfe8ae',
  meadow: '#d5eab8',
  farmland: '#eae6d0',
  cemetery: '#c8d7c0',
  military: '#e0c9c9',
  leisure_park: '#cdebb0',
  leisure_garden: '#cdebb0',
  leisure_pitch: '#aee0a8',
  leisure_track: '#c7e8ae',
  leisure_sports_centre: '#aee0c8',
  leisure_stadium: '#aee0c8',
  leisure_ice_rink: '#cfe8f5',
  // Playground fill deliberately far from the building fill (#d9d0c4) in
  // hue, not just lightness — the two used to be near-indistinguishable
  // inside courtyards, making building outlines vanish into the ground.
  leisure_playground: '#ffe2b3',
  natural_wetland: '#c7ddd4',
  recreation_ground: '#e3f4c1',
  village_green: '#cdebb0',
  allotments: '#dfe6c8',
  garages: '#d6cddb',
  construction: '#cbc9d6',
  quarry: '#cbbfa8',
  landfill: '#c9bfae',
  railway: '#d8d3d6',
  greenfield: '#e2f0d9',
  logging: '#dbe3c9',
};

// Fallback for any landuse value not covered above — kept far lighter than
// the building fill (#d9d0c4) so an unstyled polygon never reads as a
// building outline dissolving into the ground.
const LANDUSE_DEFAULT = '#eef0ef';

export function landuseColor(feature) {
  const lu = feature.properties.landuse;
  return LANDUSE_COLORS[lu] || LANDUSE_DEFAULT;
}

// The OSM-shaped tags that say what kind of place a POI is, in priority
// order. Used both for its label and to tell an actual place apart from a
// stray untagged node.
function poiKindTag(props) {
  return props.amenity || props.shop || props.office ||
    props.healthcare || props.craft || props.tourism || props.leisure || '';
}

export function hasPoiIdentity(props) {
  return !!(props.name || poiKindTag(props));
}

export function poiLabel(props) {
  // `category` (2GIS, already human-readable Russian) takes priority;
  // the amenity/shop/... fallback is only for any leftover OSM-shaped data.
  if (props.category) return props.category;
  if (props.amenity === 'atm') return 'банкомат';
  return poiKindTag(props);
}

// ATMs in OSM rarely carry a name — the bank is only recoverable from the
// website domain, so map the domains actually present in data/poi.geojson.
const BANK_BY_DOMAIN = {
  'chelindbank.ru': 'Челиндбанк',
  'sberbank.ru': 'Сбербанк',
  'snbank.ru': 'банк «Снежинский»',
  'vtb.ru': 'ВТБ',
};

export function bankFromWebsite(website) {
  if (!website) return '';
  for (const domain in BANK_BY_DOMAIN) {
    if (website.includes(domain)) return BANK_BY_DOMAIN[domain];
  }
  return '';
}

// Admin/social building types worth labeling on the map even when OSM has
// no `name` for the specific building — e.g. most schools/kindergartens in
// this dataset carry only building=school|kindergarten with an empty name.
// `amenity` (more specific) wins over `building` when both are present.
const ADMIN_BUILDING_LABELS = {
  school: 'Школа',
  kindergarten: 'Детский сад',
  government: 'Администрация',
  public: 'Общественное здание',
  public_building: 'Общественное здание',
  hospital: 'Больница',
  clinic: 'Поликлиника',
  dentist: 'Стоматология',
  veterinary: 'Ветклиника',
  townhall: 'Администрация',
  courthouse: 'Суд',
  police: 'Полиция',
  fire_station: 'Пожарная часть',
  library: 'Библиотека',
  cinema: 'Кинотеатр',
  university: 'Университет',
  college: 'Колледж',
  community_centre: 'Дом культуры',
  social_facility: 'Соцучреждение',
  mortuary: 'Дом прощаний',
  place_of_worship: 'Храм',
  church: 'Храм',
};

// Same idea, keyed on the 2GIS `category` text instead of an OSM tag value
// — for standalone POIs (no enclosing building) sourced from the new data.
const ADMIN_CATEGORY_LABELS = {
  'Школы': 'Школа',
  'Детские сады': 'Детский сад',
};

export function adminBuildingLabel(props) {
  return ADMIN_BUILDING_LABELS[props.amenity] || ADMIN_BUILDING_LABELS[props.building] ||
    ADMIN_CATEGORY_LABELS[props.category] || '';
}

// Most leisure=stadium ways in OSM have no `name`; for those, `sport` at
// least gives a generic Russian label instead of nothing.
const STADIUM_SPORT_LABELS = {
  hockey: 'Хоккейная коробка',
  skiing: 'Лыжная трасса',
  soccer: 'Стадион',
};

export function stadiumLabel(props) {
  if (props.landuse !== 'leisure_stadium') return '';
  return props.name || STADIUM_SPORT_LABELS[props.sport] || '';
}

export function isGarage(feature) {
  const b = feature && feature.properties.building;
  return b === 'garage' || b === 'garages';
}

// Memorials (data/memorials.geojson): monuments/sculptures vs wall plaques.
export function isPlaque(props) {
  return props.kind === 'plaque';
}

export function memorialTypeLabel(props) {
  return isPlaque(props) ? 'Мемориальная доска' : 'Памятник, скульптура';
}

// Map label: drop the leading "Памятник"/"Скульптура" (the marker already says
// what it is) and cut the long dedication names down to something that fits.
export function memorialLabel(props) {
  let name = (props.name || '').replace(/^(Памятник|Скульптура|Мемориал)\s+/i, '');
  if (name.length > MEMORIAL_LABEL_MAX_CHARS) {
    const cut = name.slice(0, MEMORIAL_LABEL_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    name = (space > 10 ? cut.slice(0, space) : cut) + '…';
  }
  return name;
}

export const BUILDING_STYLE = {
  normal: { color: '#c4b9a8', weight: 1, fillColor: '#d9d0c4', fillOpacity: 0.95 },
  garage: { color: '#a99bb8', weight: 1, fillColor: '#d6cddb', fillOpacity: 0.95 },
  // Satellite/hybrid: invisible, but still there to catch popup clicks.
  hidden: { stroke: false, fill: true, fillOpacity: 0 },
};

export const WATER_STYLE = { color: '#a3ccdb', weight: 1, fillColor: '#aad3df', fillOpacity: 1 };
export const RAILWAY_STYLE = { color: '#8a8a8a', weight: 2, dashArray: '1,6' };

export const PARKING_STYLE = {
  fill: '#c9d6e3',
  border: '#8fa3ba',
  markerBg: '#2f6fb0',
};
