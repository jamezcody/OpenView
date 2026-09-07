export const MAP_FALLBACK = {
  url: '/cesium/Assets/Textures/NaturalEarthII/{z}/{x}/{reverseY}.jpg',
  max: 2,
  credit: 'Natural Earth II · public domain',
} as const;

export const LAYERS = [
  {
    id: 'satellite',
    name: 'Satellite',
    detail: 'Esri World Imagery · mosaic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    missingTileUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/23/0/0',
    credit:
      'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  {
    id: 'streets',
    name: 'Streets',
    detail: 'OpenStreetMap · street-level',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    max: 19,
    missingTileUrl: null,
    credit: '© OpenStreetMap contributors · openstreetmap.org/copyright',
  },
  {
    id: 'topographic',
    name: 'Topographic',
    detail: 'Esri · terrain cartography',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    max: 17,
    missingTileUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/23/0/0',
    credit:
      'Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community',
  },
] as const;
export type LayerId = (typeof LAYERS)[number]['id'];
