import type { PathedFile } from './droppedFiles';

/** Procedural MaterialX documents bundled with the viewer as demos and import fixtures. */
export interface MaterialXSample {
  id: string;
  label: string;
  text: string;
}

const sources = import.meta.glob<string>('../assets/materialx/*.mtlx', { query: '?raw', import: 'default', eager: true });

// Panel order and short labels; the documents name their materials in full.
const LABELS: Record<string, string> = {
  'car-paint': 'Flake paint', 'weathered-steel': 'Rusty steel', 'galvanized-steel': 'Galvanized',
  'riveted-steel': 'Riveted steel', 'anodized-aluminum': 'Anodized', 'aircraft-aluminum': 'Aircraft skin',
  'patina-bronze': 'Bronze',
  'varnished-wood': 'Wood', 'cork': 'Cork', 'marble': 'Marble', 'terrazzo': 'Terrazzo',
  'exposed-concrete': 'Concrete', 'mossy-stone': 'Mossy stone', 'lichen': 'Lichen',
  'leather': 'Leather', 'saddle-leather': 'Saddle leather', 'quilted-leather': 'Quilted',
  'woven-leather': 'Woven leather', 'crocodile': 'Crocodile',
  'suede': 'Suede', 'denim': 'Denim', 'silk-satin': 'Satin', 'herringbone-tweed': 'Tweed',
  'rattan': 'Rattan',
  'tartan-velvet': 'Tartan', 'cobblestone': 'Cobbles', 'zellige-tile': 'Zellige',
  'crackle-glaze': 'Crackle glaze',
  'candle-wax': 'Wax', 'hammered-copper': 'Copper', 'carbon-fiber': 'Carbon',
  'damascus-steel': 'Damascus', 'kintsugi': 'Kintsugi', 'heat-tinted-titanium': 'Titanium',
  'abalone': 'Abalone', 'hex-plating': 'Hex plate',
  'brick-wall': 'Brick', 'wet-asphalt': 'Asphalt', 'chipped-paint': 'Chipped paint',
  'knit-wool': 'Knit', 'perforated-metal': 'Perforated', 'circuit-board': 'Circuit',
  'stained-glass': 'Stained glass', 'rain-glass': 'Rain glass', 'agate': 'Agate',
  'guilloche-enamel': 'Guilloché', 'dragon-scales': 'Scales', 'holo-glitter': 'Glitter',
  'cooling-lava': 'Lava', 'hex-panel': 'Hex glow', 'embers': 'Embers', 'hot-steel': 'Hot steel',
  'neon-truchet': 'Neon', 'led-matrix': 'LED matrix', 'nebula': 'Nebula'
};
const order = Object.keys(LABELS);

export const MATERIALX_SAMPLES: MaterialXSample[] = Object.entries(sources).map(([path, text]) => {
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.mtlx$/, '');
  return { id, label: LABELS[id] ?? id, text };
}).sort((a, b) => (order.indexOf(a.id) >>> 0) - (order.indexOf(b.id) >>> 0) || a.id.localeCompare(b.id));

/** The sample as an import package, as if its `.mtlx` file had been dropped. */
export const materialXSampleFiles = (sample: MaterialXSample): PathedFile[] =>
  [{ file: new File([sample.text], `${sample.id}.mtlx`, { type: 'application/xml' }), path: `${sample.id}.mtlx` }];
