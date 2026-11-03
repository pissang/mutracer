/// <reference lib="webworker" />
import { inspect, urlResolver, type Resolver } from '../../../tools/pbrt/source';
import { compactScene } from '../../../tools/pbrt/transfer';
import { buildScene } from '../../../tools/pbrt/scene';
import { parsePLY } from '../../../tools/pbrt/geometry';
import type { ModelSource } from './loadModel';

let source: ModelSource;
const cached = new Map<string, File>();
let resolver: Resolver;
let mainBytes: ArrayBuffer | undefined;
self.onmessage = async (event: MessageEvent) => {
  const { id, command } = event.data;
  try {
    let result: unknown;
    let sceneBuffers: ArrayBuffer[] = [];
    if (command === 'inspect') {
      source = event.data.source;
      mainBytes = event.data.mainBytes;
      const sizes = event.data.sizes as Record<string, number>;
      for (const item of source.files) cached.set(item.path, item.file);
      const remote = urlResolver();
      resolver = {
        async read(path) {
          if (path === source.mainPath && mainBytes) return mainBytes;
          const file = cached.get(path); if (file) return file.arrayBuffer();
          if (!source.base) throw new Error(`Include ${path} with the dropped folder`);
          const data = await remote.read(path); cached.set(path, new File([data], path.split('/').pop()!)); return data;
        },
        async size(path) {
          const file = cached.get(path); if (file) return file.size;
          if (path in sizes) return sizes[path];
          if (!source.base) throw new Error(`Missing scene resource ${path}`);
          return remote.size!(path);
        }
      };
      result = await inspect(source.mainPath, resolver);
    } else if (command === 'build') {
      const scene = await buildScene(source.mainPath, resolver);
      sceneBuffers = compactScene(scene);
      result = { scene, files: [...cached].map(([path, file]) => ({ path, file })) };
    } else if (command === 'ply') {
      const geometry = parsePLY(event.data.bytes);
      result = { attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, attribute]) => [key, { array: attribute.array, itemSize: attribute.itemSize }])), index: geometry.index?.array };
    } else throw new Error(`Unknown PBRT worker command ${command}`);
    const transfer = command === 'ply' ? [...new Set(Object.values((result as { attributes: Record<string, { array: Float32Array }> }).attributes).map(a => a.array.buffer))] : sceneBuffers;
    const index = (result as { index?: Uint32Array }).index;
    if (command === 'ply' && index && !transfer.includes(index.buffer)) transfer.push(index.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
