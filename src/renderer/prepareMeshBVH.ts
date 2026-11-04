import {materialNeedsVertexTangents} from './tangentRequirements.js';
import { isProceduralSkyImage } from '../scene/skyParameters.js';
import { prepareSceneMeshes, computeGeometryNormals, type PreparedMeshInstanceBinding as SharedInstanceBinding } from './scenePreparation.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import { meshInstanceCount, type MeshInstances } from './meshInstances.js';
import {createCanvas} from '../util/canvas.js';
import { getGeometryBvh, setGeometryBvh, geometryBvhConfigMatches, type BvhBuildConfig } from './geometryBvh.js';
import { displacementBaseGeometry, computeDisplacementMinmax, computeTrianglesDisplacementRange, conservativeTrianglesDisplacementRange } from './displacementPreparation.js';
export { sphericalProjectionTriangle, triplanarProjectionTriangle } from './displacementPreparation.js';
import Geometry from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import { buildBLAS } from './bvhAccel.js';
import Texture, { isTextureDataSource } from '../scene/Texture.js';
import { generateVertexTangents } from '../util/geometry.js';

import { getBvhBounds } from './geometryBvhBounds.js';
export { getBvhBounds } from './geometryBvhBounds.js';

export { computeBounds, updateMeshInstanceTransforms } from './scenePreparation.js';
export type PreparedMeshInstanceBinding = SharedInstanceBinding<Mesh>;

/** Returns the first material used for CPU displacement. */
export function getMeshDisplacementMaterial(mesh: Mesh) {
  return mesh.materials[0];
}

export function getMeshDisplacementMap(mesh: Mesh) {
  // Not support multiple materials for displacement.
  const material = getMeshDisplacementMaterial(mesh);
  return material.displacementMap;
}

export function getMeshDisplacementScale(mesh: Mesh) {
  return mesh.materials[0].displacementScale;
}

const preparedGeometryCache = new WeakMap<Geometry, Map<string, Geometry>>();
let displacementTextureId = 1;
const displacementTextureIds = new WeakMap<object, number>();

function getDisplacementResourceId(identity: object) {
  let id = displacementTextureIds.get(identity);
  if (id == null) {
    id = displacementTextureId++;
    displacementTextureIds.set(identity, id);
  }
  return id;
}

export function getDisplacementTextureDataCacheKey(texture: Texture) {
  const image = texture.image;
  return [
    getDisplacementResourceId(texture.source ?? texture),
    getDisplacementResourceId(image),
    texture.version,
    image.width,
    image.height
  ].join('|');
}

const displacementMinmaxCache = new Map<string, Uint8Array[]>();

export function getPreparedMeshGeometryCacheKey(mesh: Mesh) {
  const source = mesh.geometry;
  const material = getMeshDisplacementMaterial(mesh);
  const texture = material?.displacementMap;
  if (!material) return undefined;
  // UV and procedural displacement both need height-aware BLAS bounds and
  // packed triangle ranges. Never reuse the source's undisplaced tree, or a
  // different material's height field, when a texture/scale changes.
  const scale = getMeshDisplacementScale(mesh);
  if (texture && (scale !== 0 || material.displacementBias !== 0)) {
    return ['displacement', source.version, getDisplacementTextureDataCacheKey(texture),
      +texture.flipY, texture.uvScale.join(','), texture.uvOffset.join(','), texture.uvChannel, texture.wrapS, texture.wrapT, texture.colorSpace,
      scale, material.displacementBias, material.displacementUvProjectionScale, material.displacementUvProjection].join('|');
  }
  return undefined;
}

export function getCachedPreparedMeshGeometry(mesh: Mesh) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  const cached = preparedGeometryCache.get(mesh.geometry)?.get(key);
  if (!cached) {
    const geometry = new Geometry(mesh.geometry);
    geometry.dynamic = mesh.geometry.dynamic;
    geometry.version = mesh.geometry.version;
    return cachePreparedMeshGeometry(mesh, geometry);
  }
  return cached;
}

export function cachePreparedMeshGeometry(mesh: Mesh, generated: Geometry) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  let entries = preparedGeometryCache.get(mesh.geometry);
  if (!entries) {
    entries = new Map();
    preparedGeometryCache.set(mesh.geometry, entries);
  }
  if (entries.size >= 4 && !entries.has(key)) entries.clear();
  entries.set(key, generated);
  return generated;
}

/** Returns cached prepared geometry, or the source while asynchronous preparation is pending. */
export function getPreparedMeshGeometry(mesh: Mesh) {
  return getCachedPreparedMeshGeometry(mesh) ?? mesh.geometry;
}

export function computeMinmaxCPU(
  _geometry: Geometry,
  heightImage: Texture['image']
) {
  const w = heightImage.width;
  let heightPixels: ArrayLike<number>;
  let sourceChannels: number;
  let normalizeHeight: (value: number) => number;
  if (isTextureDataSource(heightImage)) {
    heightPixels = heightImage.data;
    sourceChannels = Math.max(
      1,
      Math.floor(heightImage.data.length / (heightImage.width * heightImage.height))
    );
    const normalized =
      heightImage.data instanceof Uint8Array ||
      heightImage.data instanceof Uint8ClampedArray;
    normalizeHeight = normalized
      ? (value) => value
      : (value) => Math.round(Math.min(Math.max(value, 0), 1) * 255);
  } else {
    const canvas = createCanvas();
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('The displacement texture is not CPU-readable.');
    canvas.width = w;
    canvas.height = w;
    if (isProceduralSkyImage(heightImage)) throw new Error('ProceduralSky is only supported as an environment or background.');
    ctx.drawImage(heightImage, 0, 0, w, w);
    heightPixels = ctx.getImageData(0, 0, w, w).data;
    sourceChannels = 4;
    normalizeHeight = (value) => value;
  }
  return computeDisplacementMinmax(w, sourceChannels, index => normalizeHeight(heightPixels[index]));
}

export function getTrianglesDisplacementRange(
  geometry: Geometry,
  heightTexture: Texture | undefined,
  material: OpenPBRMaterial
) {
  const indices = geometry.indexArray;
  const uvs = geometry.uv?.array;
  const uvProjection = material.displacementUvProjection;
  if (!heightTexture) return;
  if (!uvs && uvProjection === 'none') {
    throw new Error(
      'UV displacement requires texture coordinates; use triplanar, spherical, or cylindrical projection for a UV-less mesh.'
    );
  }
  const heightImage = heightTexture.image;
  const isFlipY = heightTexture.flipY;
  if (!heightImage.width || !heightImage.height) {
    return;
  }
  const triangleCount = indices.length / 3;
  // Dense meshes retain the shared conservative full-height prism path.
  const conservative = conservativeTrianglesDisplacementRange(triangleCount);
  if (conservative) return conservative;
  const minmaxCacheKey =
    getDisplacementTextureDataCacheKey(heightTexture);
  let minmaxData = displacementMinmaxCache.get(minmaxCacheKey);
  if (!minmaxData) {
    minmaxData = computeMinmaxCPU(geometry, heightImage);
    if (displacementMinmaxCache.size >= 4) {
      displacementMinmaxCache.delete(
        displacementMinmaxCache.keys().next().value!
      );
    }
    displacementMinmaxCache.set(minmaxCacheKey, minmaxData);
  }

  return computeTrianglesDisplacementRange(geometry, minmaxData, heightImage.width, isFlipY, material);
}

const warnedDirectionGeometry = new WeakSet<Geometry>();

/** Prepare auto-generated source attributes before the renderer captures array identities. */
export function ensureMeshGeometryAttributes(meshes: readonly Mesh[]) {
  for (const { geometry, materials } of meshes) {
    if (!geometry.tangent && !warnedDirectionGeometry.has(geometry) && materials.some(m => m.anisotropyMap || m.specularAnisotropyRotation !== 0 || m.coatAnisotropyRotation !== 0 || (m.specularAnisotropyModel === 'gltf' && m.specularAnisotropy > 0))) {
      console.warn('MuTracer: anisotropy direction has no vertex tangent; deriving a frame from the selected UV set with a stable fallback for degenerate UVs.');
      warnedDirectionGeometry.add(geometry);
    }
    if (!geometry.position?.array.length) continue;
    if (!geometry.normal) computeGeometryNormals(geometry);
    if (!geometry.tangent && geometry.uv && materials.some(materialNeedsVertexTangents)) generateVertexTangents(geometry);
  }
}

function getMeshBlasGeometry(mesh: Mesh, displacement = true) {
  const geometry = displacement ? getPreparedMeshGeometry(mesh) : mesh.geometry;
  if (!geometry.normal) computeGeometryNormals(geometry);
  if (!geometry.tangent && geometry.uv && mesh.materials.some(materialNeedsVertexTangents)) generateVertexTangents(geometry);
  return geometry;
}

/** Geometry and displacement inputs shared by synchronous and Worker BLAS builds. */
export function getMeshBlasInput(mesh: Mesh) {
  const geometry = getMeshBlasGeometry(mesh);
  const heightMap = getMeshDisplacementMap(mesh);
  const displacementScale = heightMap ? getMeshDisplacementScale(mesh) : 0;
  const trianglesDisplacement = displacementScale !== 0
    ? getTrianglesDisplacementRange(geometry, heightMap, getMeshDisplacementMaterial(mesh))
    : undefined;
  // Build bounds around a normal-offset base while retaining original vertex
  // attributes for texture coordinates and shading. This same input works for
  // built-in, TinyBVH and Worker builds; the shader offsets its base identically.
  const bias = heightMap ? getMeshDisplacementMaterial(mesh).displacementBias : 0;
  return { geometry: displacementBaseGeometry(geometry, bias), displacementScale, trianglesDisplacement };
}

/** Whether a static mesh still needs a BLAS before it can be rendered. */
export function meshNeedsStaticBvh(mesh: Mesh, config?: BvhBuildConfig) {
  return !!mesh.geometry.position?.array.length && !mesh.geometry.dynamic &&
    (!getGeometryBvh(getPreparedMeshGeometry(mesh)) || !!config && !geometryBvhConfigMatches(getPreparedMeshGeometry(mesh), config));
}

/** Capture inputs whose changes invalidate an asynchronous BLAS result. */
export function captureMeshBlasSnapshot(mesh: Mesh, target: Geometry) {
  const displacementMap = getMeshDisplacementMap(mesh);
  return {
    geometry: mesh.geometry,
    version: mesh.geometry.version,
    cacheKey: getPreparedMeshGeometryCacheKey(mesh),
    bvh: getGeometryBvh(target),
    displacementMap,
    displacementScale: getMeshDisplacementScale(mesh),
    displacementTextureKey: displacementMap
      ? getDisplacementTextureDataCacheKey(displacementMap) : undefined
  };
}

/** Check that a result still belongs to the captured mesh inputs. */
export function meshBlasSnapshotIsCurrent(
  mesh: Mesh, target: Geometry, snapshot: ReturnType<typeof captureMeshBlasSnapshot>
) {
  return mesh.geometry === snapshot.geometry && mesh.geometry.version === snapshot.version &&
    getPreparedMeshGeometryCacheKey(mesh) === snapshot.cacheKey && getGeometryBvh(target) === snapshot.bvh &&
    getMeshDisplacementMap(mesh) === snapshot.displacementMap &&
    getMeshDisplacementScale(mesh) === snapshot.displacementScale &&
    (!snapshot.displacementMap || getDisplacementTextureDataCacheKey(snapshot.displacementMap) ===
      snapshot.displacementTextureKey);
}

function prepareMeshGeometryBvh(mesh: Mesh, displacement = true) {
  const geometry = getMeshBlasGeometry(mesh, displacement);
  const displacementScale = displacement && getMeshDisplacementMap(mesh) ? getMeshDisplacementScale(mesh) : 0;
  if (geometry.dynamic && getGeometryBvh(geometry)?.builder !== 'builtin') setGeometryBvh(geometry, undefined);
  if (!getGeometryBvh(geometry)) {
    const input = displacement ? getMeshBlasInput(mesh) : { geometry, displacementScale, trianglesDisplacement: undefined };
    setGeometryBvh(geometry, buildBLAS(input.geometry, input.displacementScale, input.trianglesDisplacement));
  }
  return { geometry, displacementScale };
}

export function updateMeshInstances(meshes: Mesh[], options: { displacement?: boolean; mergeAttributes?: boolean } = {}) {
  return prepareSceneMeshes(meshes, mesh => prepareMeshGeometryBvh(mesh, options.displacement !== false), getBvhBounds, true, options.mergeAttributes !== false);
}

export {dirtyPreparedInstanceIndices as dirtyMeshInstanceIndices} from './scenePreparation.js';

/** Refreshes color storage without computing transforms or bounds. Returns packed source slots. */
export function updateMeshInstanceColors(bindings: PreparedMeshInstanceBinding[], instances: MeshInstances, meshes: ReadonlySet<Mesh>) {
  const dirty = new Set<number>();
  if (Array.isArray(instances)) return dirty;
  let sourceStart = 0, packedIndex = 0;
  for (const {mesh} of bindings) {
    const count = meshInstanceCount(mesh), sourceEnd = sourceStart + count;
    while (packedIndex < instances.length && instances.sourceIndices[packedIndex] < sourceEnd) {
      if (meshes.has(mesh)) {
        const localIndex = instances.sourceIndices[packedIndex] - sourceStart;
        const colors = mesh instanceof InstancedMesh ? mesh.colors : undefined;
        for (let k = 0; k < 3; k++) instances.colors[packedIndex * 3 + k] = colors?.[localIndex * 3 + k] ?? 1;
        dirty.add(packedIndex);
      }
      packedIndex++;
    }
    sourceStart = sourceEnd;
  }
  return dirty;
}
