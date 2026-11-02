import * as THREE from 'three';
import type { EquirectData } from './environment';
import { parseHDR } from './environment';

export interface ModelLighting {
  /** The model provides usable scene lights or environment lighting. */
  available: boolean;
  useByDefault?: boolean;
  environment: EquirectData | null;
  warnings: string[];
}

const vector = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const rgb = (value: unknown): value is [number, number, number] => vector(value) && value.every((v) => v >= 0);

/** Environment files needed alongside the glTF buffers and images. */
export function modelEnvironmentPaths(metadata: Record<string, unknown>): string[] {
  const entries = (metadata.pbrt as { light_sources?: Record<string, unknown>[] } | undefined)?.light_sources;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && entry.gltf === 'metadata_only' && entry.pbrt === 'infinite' && typeof entry.source === 'string')
    .map((entry) => `../source/${entry.source}`);
}

/** PFM stores floating-point RGB (or grey) rows from bottom to top. */
export function parsePFM(buffer: ArrayBuffer): EquirectData {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const line = () => {
    const start = offset;
    while (offset < bytes.length && bytes[offset] !== 10) offset++;
    if (offset === bytes.length) throw new Error('Incomplete PFM header');
    return new TextDecoder().decode(bytes.subarray(start, offset++)).trim();
  };
  const headerLine = () => {
    let text = line();
    while (!text || text.startsWith('#')) text = line();
    return text;
  };
  const format = headerLine();
  const [width, height] = headerLine().split(/\s+/).map(Number);
  const scale = Number(headerLine());
  const channels = format === 'PF' ? 3 : format === 'Pf' ? 1 : 0;
  if (!channels || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    !Number.isFinite(scale) || scale === 0 || width * height * channels * 4 !== bytes.length - offset) throw new Error('Invalid PFM image');
  const input = new DataView(buffer, offset);
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((height - 1 - y) * width + x) * channels * 4;
    const target = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) data[target + c] = input.getFloat32(source + (channels === 1 ? 0 : c * 4), scale < 0) * Math.abs(scale);
    data[target + 3] = 1;
  }
  return { width, height, data };
}

export { reprojectEnvironment } from '../../../tools/pbrt/environment';
import { reprojectEnvironment } from '../../../tools/pbrt/environment';

async function parseEnvironment(bytes: ArrayBuffer, path: string): Promise<EquirectData> {
  if (/\.pfm$/i.test(path)) return parsePFM(bytes);
  if (/\.hdr$/i.test(path)) return parseHDR(bytes);
  if (/\.exr$/i.test(path)) {
    const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
    const image = new EXRLoader().setDataType(THREE.FloatType).parse(bytes);
    if (!image.width || !image.height) throw new Error('Invalid EXR image');
    const input = image.data as Float32Array;
    const data = new Float32Array(input.length);
    // EXRLoader returns bottom-up rows; Environment takes top-down rows.
    for (let y = 0; y < image.height; y++) {
      data.set(input.subarray(y * image.width * 4, (y + 1) * image.width * 4), (image.height - 1 - y) * image.width * 4);
    }
    return { width: image.width, height: image.height, data };
  }
  throw new Error('Unsupported scene environment format');
}

/** KHR_lights_punctual is already decoded by GLTFLoader. Add the benchmark
 * repository's metadata-only lights without duplicating its emissive meshes. */
export async function loadModelLighting(
  root: THREE.Object3D,
  metadata: Record<string, unknown>,
  resource: (path: string) => Promise<ArrayBuffer>
): Promise<ModelLighting> {
  let available = false;
  let punctual = false;
  let emissive = false;
  root.traverseVisible((object) => {
    const light = object as THREE.Light;
    if (light.isLight && Number.isFinite(light.intensity) && light.intensity > 0 && light.color.toArray().some((c) => c > 0)) {
      available = punctual = true;
    }
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const pbr = material as THREE.MeshStandardMaterial;
      if (pbr.visible && pbr.emissive && pbr.emissiveIntensity > 0 && pbr.emissive.toArray().some((c) => c > 0)) emissive = true;
    }
  });
  const warnings: string[] = [];
  let environment: EquirectData | null = null;
  const pbrt = metadata.pbrt as { light_sources?: Record<string, unknown>[] } | undefined;
  const entries = pbrt?.light_sources;
  available ||= !!pbrt && emissive;
  if (!Array.isArray(entries)) return { available, useByDefault: punctual || !!pbrt, environment, warnings };
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    // Decorative emissive materials do not imply a complete scene-lighting
    // setup. Keep explicitly authored area lights, which use emissive meshes.
    if (emissive && typeof entry.pbrt === 'string' && /area/i.test(entry.pbrt) &&
      typeof entry.gltf === 'string' && entry.gltf.startsWith('emissive mesh')) available = true;
    if (entry.gltf !== 'metadata_only') continue;
    const matrix = new THREE.Matrix4();
    if (Array.isArray(entry.pbrt_transform) && entry.pbrt_transform.length === 16 && entry.pbrt_transform.every(Number.isFinite)) {
      matrix.fromArray(entry.pbrt_transform);
    }
    if (entry.pbrt === 'distant' && rgb(entry.radiance_rgb) && vector(entry.from) && vector(entry.to)) {
      const from = new THREE.Vector3(...entry.from).applyMatrix4(matrix);
      const to = new THREE.Vector3(...entry.to).applyMatrix4(matrix);
      if (from.distanceToSquared(to) === 0) continue;
      const light = new THREE.DirectionalLight(new THREE.Color(...entry.radiance_rgb), 1);
      light.name = `Scene sunlight ${index + 1}`;
      light.position.copy(from);
      light.target.position.copy(to);
      light.userData.mutracerMetadataLight = true;
      light.target.userData.mutracerMetadataLightTarget = true;
      root.add(light, light.target);
      available ||= entry.radiance_rgb.some((c) => c > 0);
    } else if (entry.pbrt === 'infinite') {
      try {
        let image: EquirectData;
        if (typeof entry.source === 'string') {
          const path = `../source/${entry.source}`;
          image = reprojectEnvironment(await parseEnvironment(await resource(path), entry.source), matrix, /equiarea/i.test(entry.source));
          if (rgb(entry.radiance_rgb)) for (let i = 0; i < image.data.length; i++) if (i % 4 < 3) image.data[i] *= entry.radiance_rgb[i % 4];
        } else if (rgb(entry.radiance_rgb)) {
          image = { width: 1, height: 1, data: new Float32Array([...entry.radiance_rgb, 1]) };
        } else continue;
        if (!environment) environment = image;
        else {
          // All benchmark scenes currently have one infinite light. Preserve
          // additional maps by summing them in the same world-space projection.
          const width = Math.max(environment.width, image.width), height = Math.max(environment.height, image.height);
          const combined = new Float32Array(width * height * 4);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const a = (Math.floor(y * environment.height / height) * environment.width + Math.floor(x * environment.width / width)) * 4;
            const b = (Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width)) * 4;
            const target = (y * width + x) * 4;
            for (let c = 0; c < 3; c++) combined[target + c] = environment.data[a + c] + image.data[b + c];
            combined[target + 3] = 1;
          }
          environment = { width, height, data: combined };
        }
        available ||= image.data.some((v, i) => i % 4 < 3 && Number.isFinite(v) && v > 0);
      } catch (error) {
        warnings.push(`Scene environment ${String(entry.source)} could not be loaded: ${(error as Error).message}`);
      }
    }
  }
  return { available, useByDefault: punctual || !!pbrt, environment, warnings };
}
