import * as THREE from 'three';
import type { Converted } from '../../../tools/pbrt/convert';
import type { Warning } from '../../../tools/pbrt/source';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
// The bundled typings point at the uninstalled meshoptimizer package.
import * as meshopt from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fetchWithProgress } from './fetchWithProgress';
import type { PathedFile } from './droppedFiles';
import { loadModelLighting, modelEnvironmentPaths, type ModelLighting } from './modelLighting';

export { isHDRFile, isModelFile, readDroppedItems, toPathedFiles, type PathedFile } from './droppedFiles';

export interface LoadedModel {
  name: string;
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  lighting?: ModelLighting;
  pbrt?: { settings: Converted['settings']; warnings: Warning[] };
  /** Original files, including external buffers/textures, for reloads from OPFS. */
  source?: ModelSource;
  /** Releases blob URLs created for local files. */
  revoke(): void;
}

export interface ModelSource {
  files: PathedFile[];
  mainPath: string;
  base: string;
}

export type ModelBackend = 'webgpu' | 'webgl' | (() => Promise<'webgpu' | 'webgl'>);

export type LoadProgress = (stage: 'download' | 'parse', loaded?: number, total?: number) => void;

let draco: DRACOLoader | undefined;
function createLoader(manager?: THREE.LoadingManager) {
  const loader = new GLTFLoader(manager);
  // three's DRACOLoader defaults to its bundled decoder, fetched only for Draco files.
  draco ??= new DRACOLoader();
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder((meshopt as unknown as { MeshoptDecoder: Parameters<GLTFLoader['setMeshoptDecoder']>[0] }).MeshoptDecoder);
  return loader;
}

function parse(loader: GLTFLoader, data: ArrayBuffer, path: string) {
  return new Promise<GLTF>((resolve, reject) =>
    loader.parse(data, path, resolve, reject));
}

export async function loadModelFromURL(url: string, onProgress: LoadProgress, signal?: AbortSignal, backend: ModelBackend = 'webgpu'): Promise<LoadedModel> {
  const buffer = await fetchWithProgress(url, (loaded, total) => onProgress('download', loaded, total), signal);
  const base = new URL('.', new URL(url, location.href)).href;
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model');
  const mainPath = new URL(url, location.href).href;
  const files: PathedFile[] = [{ path: mainPath, file: new File([buffer], name) }];
  return parseModelSource({ files, mainPath, base }, onProgress, signal, backend, buffer);
}

/** Fetch every external resource before entering the parse stage. Cached files
 * are reused, and optional environment failures become lighting warnings. */
async function downloadModelResources(source: ModelSource, buffer: ArrayBuffer, onProgress: LoadProgress, signal?: AbortSignal) {
  const failures = new Map<string, unknown>(), buffers = new Map<string, ArrayBuffer>();
  if (!source.base) return {failures, buffers};
  const { files, mainPath } = source;
  // glTF/GLB resources can be external even when the main file is binary.
  let jsonBytes = new Uint8Array(buffer);
  if (buffer.byteLength >= 20 && new DataView(buffer).getUint32(0, true) === 0x46546c67) {
    jsonBytes = new Uint8Array(buffer, 20, new DataView(buffer).getUint32(12, true));
  }
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  const bufferUrls = new Set<string>((json.buffers ?? []).flatMap((resource: {uri?: string}) =>
    resource.uri && !resource.uri.startsWith('data:') ? [new URL(resource.uri, mainPath).href] : []));
  const urls = new Map<string, boolean>();
  const sizes = new Map<string, number>();
  const downloaded = new Map<string, number>();
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof resource.uri === 'string' && !resource.uri.startsWith('data:')) {
      const address = new URL(resource.uri, mainPath).href;
      urls.set(address, false);
      sizes.set(address, resource.byteLength ?? 0);
    }
  }
  for (const path of modelEnvironmentPaths(json.extras ?? {})) {
    const address = new URL(path, mainPath).href;
    if (!urls.has(address)) urls.set(address, true);
  }
  for (const { path } of files) urls.delete(new URL(path, mainPath).href);
  const cachedBytes = files.reduce((sum, { file }) => sum + file.size, 0);
  await Promise.all([...urls].map(async ([address, optional]) => {
    const report = (loaded: number, total: number) => {
      // LFS pointer resolution and retries must not reset the whole model's count.
      downloaded.set(address, Math.max(downloaded.get(address) ?? 0, loaded));
      sizes.set(address, Math.max(sizes.get(address) ?? 0, total, loaded));
      onProgress('download', cachedBytes + [...downloaded.values()].reduce((a, b) => a + b, 0),
        cachedBytes + [...urls.keys()].reduce((sum, url) => sum + (sizes.get(url) ?? 0), 0));
    };
    try {
      const bytes = await fetchWithProgress(address, report, signal);
      report(bytes.byteLength, bytes.byteLength);
      if (optional || bufferUrls.has(address)) buffers.set(address, bytes);
      files.push({ path: address, file: new File([bytes], new URL(address).pathname.split('/').pop() || 'resource') });
    } catch (error) {
      signal?.throwIfAborted();
      if (!optional) throw error;
      failures.set(address, error);
    }
  }));
  return {failures, buffers};
}

/**
 * Loads a .glb, or a .gltf with its .bin and textures picked or dropped
 * together. Relative resource URIs are resolved against the dropped paths.
 */
export async function loadModelFromFiles(files: PathedFile[], onProgress: LoadProgress, signal?: AbortSignal, backend: ModelBackend = 'webgpu'): Promise<LoadedModel> {
  const main = files.find((f) => f.path.toLowerCase().endsWith('.glb')) ??
    files.find((f) => f.path.toLowerCase().endsWith('.gltf'));
  if (!main) {
    const candidates = files.filter(f => /\.pbrt(?:\.gz)?$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    for (const file of candidates) {
      if (/WorldBegin/.test(await file.file.slice(0, 65536).text())) return loadModelFromSource({ files, mainPath: file.path, base: '' }, onProgress, signal, backend);
    }
    if (candidates.length) return loadModelFromSource({ files, mainPath: candidates[0].path, base: '' }, onProgress, signal, backend);
  }
  if (!main) throw new Error('No .glb, .gltf or .pbrt scene found');
  return loadModelFromSource({ files, mainPath: main.path, base: '' }, onProgress, signal, backend);
}

/** Parses the same bytes for downloaded, dropped and restored models. */
export async function loadModelFromSource(source: ModelSource, onProgress: LoadProgress, signal?: AbortSignal, backend: ModelBackend = 'webgpu'): Promise<LoadedModel> {
  return parseModelSource(source, onProgress, signal, backend);
}

async function parseModelSource(source: ModelSource, onProgress: LoadProgress, signal: AbortSignal | undefined,
  backend: ModelBackend, downloadedMain?: ArrayBuffer): Promise<LoadedModel> {
  if (/\.pbrt(?:\.gz)?(?:[?#].*)?$/i.test(source.mainPath)) return (await import('./pbrt')).loadPBRT(source, onProgress, signal, backend, downloadedMain);
  const { files, mainPath, base } = source;
  const main = files.find((file) => file.path === mainPath);
  if (!main) throw new Error('Missing main model file');
  const buffer = downloadedMain ?? await main.file.arrayBuffer();
  const {failures, buffers} = await downloadModelResources(source, buffer, onProgress, signal);
  signal?.throwIfAborted();
  const mainDir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
  const blobs = new Map<string, string>();
  const created: string[] = [];
  for (const { file, path } of files) {
    if (file === main.file) continue;
    const url = URL.createObjectURL(file);
    created.push(url);
    const relative = path.startsWith(mainDir) ? path.slice(mainDir.length) : path;
    blobs.set(relative, url);
    blobs.set(path, url);
    if (!blobs.has(file.name)) blobs.set(file.name, url);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (blobs.has(url)) return blobs.get(url)!;
    if (url.startsWith('data:') || url.startsWith('blob:') || /^https?:/.test(url)) return url;
    const clean = decodeURIComponent(url.replace(/^\.\//, ''));
    return blobs.get(clean) ?? blobs.get(clean.split('/').pop()!) ?? url;
  });
  onProgress('parse');
  let gltf: Awaited<ReturnType<typeof parse>>;
  try {
    const mainAddress = new URL(mainPath, 'https://model.local/');
    const loader = createLoader(manager);
    // Scope predownloaded buffers to this parser, including Meshopt's buffer
    // dependencies. Keep Three's global cache and other concurrent loads independent.
    loader.register(parser => {
      const loadBuffer = parser.loadBuffer.bind(parser);
      parser.loadBuffer = index => {
        const uri = parser.json.buffers[index].uri;
        const data = typeof uri === 'string' ? buffers.get(new URL(uri, mainAddress).href) : undefined;
        return data ? Promise.resolve(data) : loadBuffer(index);
      };
      return {name: 'MUTRACER_download_buffers'};
    });
    gltf = await parse(loader, buffer, base);
    const lighting = await loadModelLighting(gltf.scene, gltf.userData, async (path) => {
      const address = new URL(path, mainAddress);
      const downloaded = buffers.get(address.href);
      if (downloaded) return downloaded;
      const cached = files.find((entry) => new URL(entry.path, 'https://model.local/').href === address.href);
      if (cached) return cached.file.arrayBuffer();
      if (failures.has(address.href)) throw failures.get(address.href);
      throw new Error('Include the environment map with the dropped folder');
    });
    signal?.throwIfAborted();
    return {
      name: main.file.name,
      root: gltf.scene,
      animations: gltf.animations,
      lighting,
      source,
      revoke: () => created.forEach((url) => URL.revokeObjectURL(url))
    };
  } catch (error) {
    created.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  } finally {buffers.clear();}
}

/** Default scene: one sphere per OpenPBR feature, readable without a download. */
export function createMaterialSpheres(): LoadedModel {
  const root = new THREE.Group();
  root.name = 'Material spheres';
  const geometry = new THREE.SphereGeometry(0.42, 96, 48);
  const add = (name: string, material: THREE.MeshPhysicalMaterial, x: number, z: number) => {
    material.name = name;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(x, 0.42, z);
    root.add(mesh);
  };
  add('Ceramic', new THREE.MeshPhysicalMaterial({ color: 0xf2ece2, roughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.05 }), -1.9, 0);
  add('Brushed gold', new THREE.MeshPhysicalMaterial({ color: 0xffc35a, metalness: 1, roughness: 0.28, anisotropy: 0.6 }), -0.95, 0);
  add('Glass', new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, transmission: 1, ior: 1.5, thickness: 0.8, attenuationColor: 0x9fd4ff, attenuationDistance: 1.2 }), 0, 0);
  add('Car paint', new THREE.MeshPhysicalMaterial({ color: 0xa3140d, roughness: 0.45, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02 }), 0.95, 0);
  add('Velvet', new THREE.MeshPhysicalMaterial({ color: 0x2a0f45, roughness: 0.9, sheen: 1, sheenColor: 0xc49bff, sheenRoughness: 0.4 }), 1.9, 0);
  const iridescent = new THREE.MeshPhysicalMaterial({ color: 0x15161a, metalness: 0, roughness: 0.15, iridescence: 1, iridescenceIOR: 1.4, iridescenceThicknessRange: [300, 600] });
  add('Soap film', iridescent, -0.475, -1.05);
  const jade = new THREE.MeshPhysicalMaterial({ color: 0x5fae7f, roughness: 0.3 });
  jade.userData.mutracerOpenPBR = { subsurfaceWeight: 1, subsurfaceColor: [0.25, 0.62, 0.38], subsurfaceRadius: 0.25 };
  add('Jade', jade, 0.475, -1.05);
  return { name: 'Material spheres', root, animations: [], revoke() {} };
}
