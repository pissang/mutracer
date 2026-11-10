import { MaterialGraph } from '@meimu/mutracer';
import type { MaterialXGraphImport } from './materialxGraph';
import type { MaterialXPackage } from './materialxFiles';
import { planDisplacement } from './materialxDisplacement';
import type { MaterialXHeight, TextureTransform } from './modelCache';

const heightToken = /(?:^|[_.\s-])(?:height|displacement|disp)(?=$|[_.\s-]|\d)/i;
const stem = (path: string) => path.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '');
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1_$2');
const key = (name: string) => words(name).toLowerCase().replace(/[_.\s-]+/g, '_');

/** Keep unconnected heights as optional uploads; never alter authored displacement. */
export function findMaterialXHeights(material: MaterialXGraphImport, pkg: MaterialXPackage): MaterialXHeight[] {
  if (material.displacement || !pkg.files) return [];
  const dir = pkg.path.includes('/') ? pkg.path.slice(0, pkg.path.lastIndexOf('/') + 1) : '';
  const documents = [...pkg.files.keys()].filter(path => /\.mtlx$/i.test(path));
  const names = [stem(pkg.path), material.name, ...[...material.images.values()].map(image => stem(image.file))]
    .map(name => key(name).replace(/_(?:basecolor|base_color|normal|roughness|metalness|orm|height|displacement|disp)(?:_.*)?$/, ''));
  return [...pkg.files].filter(([path]) => {
    if (!/\.(png|jpe?g|webp|avif)$/i.test(path)) return false;
    const name = words(stem(path));
    if (!heightToken.test(name)) return false;
    // In multi-material archives, avoid suggesting another document's textures.
    return (documents.length === 1 && path.startsWith(dir)) || names.some(prefix => key(name).startsWith(prefix + '_'));
  }).sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({
    name: path.startsWith(dir) ? path.slice(dir.length) : path, file, transform: heightTransform(material, path)
  }));
}

function heightTransform(material: MaterialXGraphImport, path: string): TextureTransform {
  const fallback: TextureTransform = { uvScale: [1, 1], flipY: true, colorSpace: 'linear', uvChannel: 0, wrapS: 'repeat', wrapT: 'repeat' };
  if (!material.graph) return fallback;
  const prefix = words(stem(path)).split(heightToken)[0].toLowerCase();
  const images = [...material.images].sort(([, a], [, b]) =>
    Number(words(stem(b.file)).toLowerCase().startsWith(prefix)) - Number(words(stem(a.file)).toLowerCase().startsWith(prefix)));
  for (const [id, image] of images) {
    const source = material.graph.nodes.find(node => node.id === id);
    if (!source || !['image', 'tiledimage'].includes(source.category)) continue;
    // Probe only the image coordinates, independent of its color channels or surface math.
    const inputs = { ...source.inputs };
    delete inputs.default;
    const nodes = material.graph.nodes.map(node => node === source ? { ...node, type: 'float' as const, inputs } : node);
    const plan = planDisplacement(new MaterialGraph({ nodes, terminal: { specularRoughness: { node: id } } }));
    if (plan.direct) return { ...fallback, uvScale: plan.direct.uvScale, uvOffset: plan.direct.uvOffset, uvChannel: plan.uvChannel,
      wrapS: image.wrapS ?? 'repeat', wrapT: image.wrapT ?? 'repeat' };
  }
  return fallback;
}
