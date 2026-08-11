// Styling rules mapping OSM tags to a Google-Maps-like look

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

function roadStyle(feature) {
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

function landuseColor(feature) {
  const lu = feature.properties.landuse;
  return LANDUSE_COLORS[lu] || LANDUSE_DEFAULT;
}

const POI_CATEGORY_COLORS = {
  amenity: '#e55e5e',
  shop: '#4f8ff0',
  office: '#8a5fc9',
};

function poiColor(props) {
  if (props.amenity) return POI_CATEGORY_COLORS.amenity;
  if (props.shop) return POI_CATEGORY_COLORS.shop;
  if (props.office) return POI_CATEGORY_COLORS.office;
  return '#999999';
}

function poiLabel(props) {
  if (props.amenity === 'atm') return 'банкомат';
  return props.amenity || props.shop || props.office ||
    props.healthcare || props.craft || props.tourism || props.leisure || '';
}

// ATMs in OSM rarely carry a name — the bank is only recoverable from the
// website domain, so map the domains actually present in data/poi.geojson.
const BANK_BY_DOMAIN = {
  'chelindbank.ru': 'Челиндбанк',
  'sberbank.ru': 'Сбербанк',
  'snbank.ru': 'банк «Снежинский»',
  'vtb.ru': 'ВТБ',
};

function bankFromWebsite(website) {
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

function adminBuildingLabel(props) {
  return ADMIN_BUILDING_LABELS[props.amenity] || ADMIN_BUILDING_LABELS[props.building] || '';
}

const PARKING_STYLE = {
  fill: '#c9d6e3',
  border: '#8fa3ba',
  markerBg: '#2f6fb0',
};
