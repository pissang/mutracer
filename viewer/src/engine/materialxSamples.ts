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
  'car-paint': 'Flake paint', 'weathered-steel': 'Rusty steel', 'varnished-wood': 'Wood',
  'marble': 'Marble', 'terrazzo': 'Terrazzo', 'leather': 'Leather',
  'tartan-velvet': 'Tartan', 'cobblestone': 'Cobbles', 'zellige-tile': 'Zellige',
  'candle-wax': 'Wax', 'hammered-copper': 'Copper', 'carbon-fiber': 'Carbon',
  'damascus-steel': 'Damascus', 'kintsugi': 'Kintsugi', 'heat-tinted-titanium': 'Titanium',
  'abalone': 'Abalone', 'hex-plating': 'Hex plate', 'cooling-lava': 'Lava', 'hex-panel': 'Hex glow'
};
const order = Object.keys(LABELS);

export const MATERIALX_SAMPLES: MaterialXSample[] = Object.entries(sources).map(([path, text]) => {
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.mtlx$/, '');
  return { id, label: LABELS[id] ?? id, text };
}).sort((a, b) => (order.indexOf(a.id) >>> 0) - (order.indexOf(b.id) >>> 0) || a.id.localeCompare(b.id));

/** The sample as an import package, as if its `.mtlx` file had been dropped. */
export const materialXSampleFiles = (sample: MaterialXSample): PathedFile[] =>
  [{ file: new File([sample.text], `${sample.id}.mtlx`, { type: 'application/xml' }), path: `${sample.id}.mtlx` }];
