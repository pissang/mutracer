import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type {SceneLight} from '../scene/Scene.js';
import type Texture from '../scene/Texture.js';
import {isTextureDataSource} from '../scene/Texture.js';
import {textureWrapIndex} from '../scene/TextureState.js';
import {isUdimTexture} from '../scene/UdimTexture.js';
import {MATERIAL_TEXTURE_NAMES, MATERIAL_TEXTURE_SLOTS} from './materialTextureSlots.js';
import {mergeTexturesFromMaterials} from './materialTextures.js';
import {createMaterialBufferData, repackMaterialParams} from './materialParams.js';
import {packMaterialBuffer, MATERIAL_FLOAT_COUNT} from './materialLayout.js';
import type {MaterialGraphState} from './materialGraph/state.js';

// Browser adapter intentionally keeps the shared/native MaterialData entry intact.
export class WGPUBindlessMaterialData {
  readonly bufferData;
  readonly textures: Texture[];
  readonly defines: Record<string, number>;
  private readonly lightIndices: number[] = [];
  private readonly displacementMaps: Texture[];
  private materialCount: number;
  materials: OpenPBRMaterial[];
  private readonly retainedCapabilities: OpenPBRMaterial[];
  get capabilityMaterials() { return this.graphs?.capabilityMaterials(this.retainedCapabilities) ?? this.materials; }
  constructor(materials: OpenPBRMaterial[], lights: SceneLight[], private readonly graphs?: MaterialGraphState) {
    this.materialCount = materials.length; graphs?.request(materials);
    this.retainedCapabilities = graphs?.slotCapabilities() ?? [];
    materials = this.materials = graphs?.renderMaterials(materials) ?? materials;
    const ordinaryTextures = new Set(materials.flatMap(material => MATERIAL_TEXTURE_NAMES.flatMap(name => material[name] ? [material[name]!] : [])));
    const extra = (graphs?.textures() ?? []).filter(texture => !ordinaryTextures.has(texture));
    if(extra.length) materials = [...materials, ...extra.map(map => new OpenPBRMaterial({map}))];
    const maps = mergeTexturesFromMaterials(materials, MATERIAL_TEXTURE_NAMES);
    this.textures = maps.textures.slice();
    this.displacementMaps = maps.indices.displacementMap.map(index => maps.textures[index]).filter(Boolean);
    for (const light of lights) {
      const texture = light.type === 'RectLight' ? light.texture : undefined;
      this.lightIndices.push(texture ? this.textures.length : -1);
      if (texture) this.textures.push(texture);
    }
    this.bufferData = createMaterialBufferData(materials);
    this.defines = {NUM_MAPS: this.textures.length, NUM_UDIM_MAPS: this.textures.filter(t => isUdimTexture(t)).length};
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      this.bufferData[slot.index] = maps.indices[slot.property];
      if (slot.define) this.defines[slot.define] = maps.indices[slot.property].filter(index => index >= 0).length;
    }
    for (const slot of MATERIAL_TEXTURE_SLOTS) if (slot.define && this.capabilityMaterials.some(material => material[slot.property])) this.defines[slot.define] = Math.max(1, this.defines[slot.define] ?? 0);
    this.bufferData.normalMapIndex = this.bufferData.normalMapIndex.map((index,i) => index >= 0 && materials[i].normalMap?.normalMapFrame === 'materialx' ? index + 0.5 : index);
    this.bufferData.mapUvChannel = this.textures.map(t => t.uvChannel);
    this.bufferData.mapColorLinear = this.textures.map(t => isUdimTexture(t) ? 2 + textureColorLinear(t) : textureColorLinear(t));
    this.bufferData.mapTransform = this.textures.flatMap(t => [...t.uvScale, ...t.uvOffset]);
    this.bufferData.mapWrap = this.textures.flatMap(t => [textureWrapIndex(t.wrapS), textureWrapIndex(t.wrapT)]);
  }
  repackParams(materials: OpenPBRMaterial[]) { this.graphs?.request(materials); materials = this.materials = this.graphs?.renderMaterials(materials) ?? materials; repackMaterialParams(this.bufferData, materials); }
  getBufferArray() { const packed = packMaterialBuffer(this.bufferData); const buffer = packed.length > this.materialCount * MATERIAL_FLOAT_COUNT ? packed.slice(0, this.materialCount * MATERIAL_FLOAT_COUNT) : packed; return this.graphs?.pack(buffer,this.textures) ?? buffer; }
  getLightTexturesIndices() { return this.lightIndices; }
  getDisplacementMaps() { return this.displacementMaps; }
}
export function textureFloatStorage(texture: Texture) {
  const source = texture.image;
  return isTextureDataSource(source) && !(source.data instanceof Uint8Array) && !(source.data instanceof Uint8ClampedArray);
}
export function textureColorLinear(texture: Texture) {
  return Number(texture.colorSpace ? texture.colorSpace === 'linear' : textureFloatStorage(texture));
}
