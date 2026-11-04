// Per-record descriptor decoders shared by full preparation and incremental sync,
// so both build identical scene objects from the same bytes.
import {rememberKernelBounds, type GeometryKernelHint} from './geometry-kernel-hints.js';
import {generateVertexTangents, installGeneratedVertexTangents} from '../../src/util/geometry.js';
import {TEXTURE as T, MATERIAL as MAT, GEOMETRY as G, MESH as M, BATCH as B, LIGHT as L} from './layout.js';
import IESProfile, {parseIESProfile} from '../../src/scene/IESProfile.js';
import {applyNativeMaterialProperties} from './material-properties.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import MaterialState from '../../src/scene/MaterialState.js';
import type {TextureDataSource} from '../../src/scene/textureData.js';
import PixelTexture from '../../src/scene/PixelTexture.js';
import type TextureState from '../../src/scene/TextureState.js';
import {InstanceState, RectLightState, SphereLight, DirectionalLight, SpotLight} from '../../src/renderer/lightCore.js';
import type {AnalyticLightState} from '../../src/scene/lightState.js';

const NONE = 0xffffffff;

export function decodeTexture(bytes: Uint8Array, u: Uint32Array, f: Float32Array, off: number, images?: Map<string, TextureDataSource>): PixelTexture {
  const key = `${u[off + T.PIXELS]}:${u[off + T.WIDTH]}:${u[off + T.HEIGHT]}:${u[off + T.STORAGE]}`;
  let image = images?.get(key);
  if (!image) {
    const data = u[off + T.STORAGE] === 0
      ? new Uint8Array(bytes.buffer, bytes.byteOffset + u[off + T.PIXELS] * 4, u[off + T.WIDTH] * u[off + T.HEIGHT] * 4).slice()
      : f.slice(u[off + T.PIXELS], u[off + T.PIXELS] + u[off + T.WIDTH] * u[off + T.HEIGHT] * 4);
    image = {width: u[off + T.WIDTH], height: u[off + T.HEIGHT], data};
    images?.set(key, image);
  }
  const texture = new PixelTexture(image);
  texture.flipY = !!u[off + T.FLIP_Y]; texture.uvChannel = u[off + T.UV_CHANNEL] === 1 ? 1 : 0;
  texture.uvScale = [f[off + T.UV_SCALE], f[off + T.UV_SCALE + 1]]; texture.uvOffset = [f[off + T.UV_OFFSET], f[off + T.UV_OFFSET + 1]];
  texture.wrapS = u[off + T.WRAP_S] === 1 ? 'clamp-to-edge' : u[off + T.WRAP_S] === 2 ? 'mirrored-repeat' : 'repeat';
  texture.wrapT = u[off + T.WRAP_T] === 1 ? 'clamp-to-edge' : u[off + T.WRAP_T] === 2 ? 'mirrored-repeat' : 'repeat';
  return texture;
}

export function decodeMaterial(u: Uint32Array, f: Float32Array, off: number, textures: PixelTexture[]): MaterialState {
  const m = new MaterialState({baseColor: [f[off + MAT.BASE_COLOR], f[off + MAT.BASE_COLOR + 1], f[off + MAT.BASE_COLOR + 2]],
    specularRoughness: f[off + MAT.ROUGHNESS], baseMetalness: f[off + MAT.METALNESS], transmissionWeight: f[off + MAT.TRANSMISSION],
    specularIor: f[off + MAT.IOR], emissionColor: [f[off + MAT.EMISSION_COLOR], f[off + MAT.EMISSION_COLOR + 1], f[off + MAT.EMISSION_COLOR + 2]],
    emissionLuminance: f[off + MAT.EMISSION_LUMINANCE], coatWeight: f[off + MAT.COAT_WEIGHT], coatRoughness: f[off + MAT.COAT_ROUGHNESS],
    geometryOpacity: f[off + MAT.OPACITY], geometryThinWalled: !!u[off + MAT.THIN_WALLED]});
  m.map = u[off + MAT.MAP] === NONE ? undefined : textures[u[off + MAT.MAP]];
  m.normalMap = u[off + MAT.NORMAL_MAP] === NONE ? undefined : textures[u[off + MAT.NORMAL_MAP]];
  m.metallicRoughnessMap = u[off + MAT.METALLIC_ROUGHNESS_MAP] === NONE ? undefined : textures[u[off + MAT.METALLIC_ROUGHNESS_MAP]];
  m.emissiveMap = u[off + MAT.EMISSIVE_MAP] === NONE ? undefined : textures[u[off + MAT.EMISSIVE_MAP]];
  applyNativeMaterialProperties(m, textures, u, f, u[off + MAT.EXTENSION_OFFSET], u[off + MAT.EXTENSION_COUNT]);
  return m;
}

export function decodeGeometry(u: Uint32Array, f: Float32Array, off: number, hint: GeometryKernelHint | undefined, borrow = false, needsTangents = true): Geometry {
  // Full preparation receives an AOT-owned descriptor. Views keep that allocation
  // alive through retained geometry. Sync keeps separate mutable arrays so edits
  // cannot overwrite its previous descriptor or rollback snapshot.
  const floats = (offset: number, count: number) => borrow ? f.subarray(offset, offset + count) : f.slice(offset, offset + count);
  const words = (offset: number, count: number) => borrow ? u.subarray(offset, offset + count) : u.slice(offset, offset + count);
  const count = u[off + G.VERTEX_COUNT], indexCount = u[off + G.INDEX_COUNT];
  // Let the shared constructor generate normals only when the input omits
  // them. Assigning authored normals afterwards needlessly traversed all faces.
  const geometry = new Geometry({position: new Attribute(floats(u[off + G.POSITION], count * 3), 3),
    indices: new Attribute(words(u[off + G.INDICES], indexCount), 1),
    normal: u[off + G.NORMAL] ? new Attribute(floats(u[off + G.NORMAL], count * 3), 3) : undefined});
  if (u[off + G.UV]) geometry.uv = new Attribute(floats(u[off + G.UV], count * 2), 2);
  if (u[off + G.UV1]) geometry.uv1 = new Attribute(floats(u[off + G.UV1], count * 2), 2);

  if (u[off + G.COLOR]) geometry.color = new Attribute(floats(u[off + G.COLOR], count * 3), 3);
  if (u[off + G.TANGENT]) geometry.tangent = new Attribute(floats(u[off + G.TANGENT], count * 4), 4);
  if (u[off + G.MATERIAL_INDEX]) geometry.materialIndex = new Attribute(new Int32Array(words(u[off + G.MATERIAL_INDEX], count)), 1);

  if (hint) {
    if (hint.vertexCount !== count) throw new Error('Kernel vertex count mismatch');
    if(hint.bounds) rememberKernelBounds(geometry, hint.bounds);
    if (!geometry.tangent && hint.tangents) installGeneratedVertexTangents(geometry,hint.tangents);
  }
  if (needsTangents && !geometry.tangent && geometry.uv) generateVertexTangents(geometry);
  return geometry;
}

export function decodeMeshMaterials(u: Uint32Array, off: number, materials: MaterialState[]): MaterialState[] {
  const meshMaterials: MaterialState[] = [];
  if (u[off + M.MATERIAL_COUNT]) {
    for (let k = 0; k < u[off + M.MATERIAL_COUNT]; k++) meshMaterials.push(materials[u[u[off + M.MATERIAL_TABLE] + k]]);
  } else meshMaterials.push(materials[u[off + M.MATERIAL]]);
  return meshMaterials;
}

/** Undefined for an ordinary mesh (count UINT32_MAX); zero is an empty batch. */
export function decodeInstances(u: Uint32Array, f: Float32Array, io: number): InstanceState | undefined {
  const instanceCount = u[io + B.COUNT];
  if (instanceCount === NONE) return undefined;
  return new InstanceState({count: instanceCount,
    transforms: f.slice(u[io + B.TRANSFORMS], u[io + B.TRANSFORMS] + instanceCount * 16),
    colors: u[io + B.COLORS] ? f.slice(u[io + B.COLORS], u[io + B.COLORS] + instanceCount * 3) : undefined});
}

export function lightFromRecord(u: Uint32Array, f: Float32Array, off: number, texture: TextureState | undefined): AnalyticLightState {
  let light: AnalyticLightState;
  if (u[off + L.TYPE] === 0) light = new RectLightState({size: [f[off + L.SIZE], f[off + L.HEIGHT_OR_INNER]], spread: f[off + L.SPREAD_OR_OUTER], texture});
  else if (u[off + L.TYPE] === 1) light = new SphereLight({radius: f[off + L.SIZE]});
  else if (u[off + L.TYPE] === 2) light = new DirectionalLight();
  else light = new SpotLight({radius: f[off + L.SIZE], innerAngle: f[off + L.HEIGHT_OR_INNER], outerAngle: f[off + L.SPREAD_OR_OUTER]});
  light.color = [f[off + L.COLOR], f[off + L.COLOR + 1], f[off + L.COLOR + 2]]; light.intensity = f[off + L.INTENSITY];
  light.transform = f.slice(off + L.TRANSFORM, off + L.TRANSFORM + 16);
  return light;
}

/** Lights that reuse an IES offset/length pair share one parsed profile. */
export function decodeLight(bytes: Uint8Array, u: Uint32Array, f: Float32Array, off: number, textures: PixelTexture[],
  iesProfiles: Map<string, IESProfile>): AnalyticLightState {
  const light = lightFromRecord(u, f, off, u[off + L.TEXTURE] ? textures[u[off + L.TEXTURE] - 1] : undefined);
  if (light.type === 'SpotLight' && u[off + L.IES_BYTES]) {
    const key = `${u[off + L.IES_OFFSET]}:${u[off + L.IES_BYTES]}`;
    let profile = iesProfiles.get(key);
    if (!profile) {
      profile = parseIESProfile(new TextDecoder().decode(bytes.subarray(u[off + L.IES_OFFSET] * 4, u[off + L.IES_OFFSET] * 4 + u[off + L.IES_BYTES])), 'native scene');
      iesProfiles.set(key, profile);
    }
    light.iesProfile = profile;
  }
  return light;
}
