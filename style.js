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
  leisure_sports_centre: '#aee0c8',
  leisure_stadium: '#aee0c8',
  natural_wetland: '#c7ddd4',
};

function landuseColor(feature) {
  const lu = feature.properties.landuse;
  return LANDUSE_COLORS[lu] || '#e6e6e6';
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
  return props.amenity || props.shop || props.office || '';
}

const PARKING_STYLE = {
  fill: '#c9d6e3',
  border: '#8fa3ba',
  markerBg: '#2f6fb0',
};
