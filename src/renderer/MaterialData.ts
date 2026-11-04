import type MaterialState from '../scene/MaterialState.js';
import type TextureState from '../scene/TextureState.js';
import { MATERIAL_TEXTURE_NAMES, MATERIAL_TEXTURE_SLOTS } from './materialTextureSlots.js';
import { mergeTexturesFromMaterials } from './materialTextures.js';
import { createMaterialBufferData, repackMaterialParams } from './materialParams.js';
import { packMaterialBuffer } from './materialLayout.js';
import { planTextureAtlas, type MaterialTableOptions, type TextureAtlasPlan } from './textureAtlas.js';
import type { BufferData } from './materialBufferData.js';

// CPU material preparation shared by browser uploads and native command generation.
// The adapter describes source encoding; the core never decodes DOM/GPU resources.
export default class MaterialData {
  bufferData: BufferData;
  textures: TextureState[];
  displacementMaps: TextureState[];
  lightTexturesIndices: number[] = [];
  defines: Record<string, number> = {};
  atlas: TextureAtlasPlan;
  constructor(materials: MaterialState[], lightTextures: (TextureState | undefined)[],
    colorLinear: (texture: TextureState) => number, options: MaterialTableOptions = {},
    floatStorage?: (texture: TextureState) => boolean) {
    const maps = mergeTexturesFromMaterials(materials, MATERIAL_TEXTURE_NAMES);
    this.displacementMaps = maps.indices.displacementMap.map(index => maps.textures[index]).filter(texture => !!texture);
    this.textures = maps.textures.slice();
    for (const texture of lightTextures) {
      if (texture) {
        const existing = options.independentTextures ? this.textures.indexOf(texture) : -1;
        if (existing >= 0) this.lightTexturesIndices.push(existing);
        else { this.lightTexturesIndices.push(this.textures.length); this.textures.push(texture); }
      }
      else this.lightTexturesIndices.push(-1);
    }
    this.bufferData = createMaterialBufferData(materials);
    this.bufferData.diffuseMapIndex = maps.indices.map;
    this.bufferData.alphaMapIndex = maps.indices.alphaMap;
    this.bufferData.normalMapIndex = maps.indices.normalMap;
    this.bufferData.emissiveMapIndex = maps.indices.emissiveMap;
    this.bufferData.metallicRoughnessMapIndex = maps.indices.metallicRoughnessMap;
    this.bufferData.roughnessMapIndex = maps.indices.roughnessMap;
    this.bufferData.metalnessMapIndex = maps.indices.metalnessMap;
    this.bufferData.transmissionMapIndex = maps.indices.transmissionMap;
    this.bufferData.thinFilmMapIndex = maps.indices.thinFilmMap;
    this.bufferData.displacementMapIndex = maps.indices.displacementMap;
    this.bufferData.coatWeightMapIndex = maps.indices.coatWeightMap;
    this.bufferData.coatRoughnessMapIndex = maps.indices.coatRoughnessMap;
    this.bufferData.fuzzColorMapIndex = maps.indices.fuzzColorMap;
    this.bufferData.fuzzRoughnessMapIndex = maps.indices.fuzzRoughnessMap;
    this.bufferData.specularWeightMapIndex = maps.indices.specularWeightMap;
    this.bufferData.specularColorMapIndex = maps.indices.specularColorMap;
    this.bufferData.anisotropyMapIndex = maps.indices.anisotropyMap;
    this.bufferData.coatNormalMapIndex = maps.indices.coatNormalMap;
    this.atlas = planTextureAtlas(this.textures, this.textures.map(colorLinear), options,
      floatStorage ? this.textures.some(floatStorage) : undefined);
    this.bufferData.mapInfo = this.atlas.mapInfo; this.bufferData.mapTransform = this.atlas.mapTransform;
    this.bufferData.mapWrap = this.atlas.mapWrap;
    this.bufferData.mapUvChannel = this.atlas.mapUvChannel; this.bufferData.mapColorLinear = this.atlas.mapColorLinear;
    this.defines = {NUM_MAPS: this.textures.length};
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      if (slot.define) this.defines[slot.define] = maps.indices[slot.property].filter(index => index >= 0).length;
    }
  }
  repackParams(materials: MaterialState[]) { repackMaterialParams(this.bufferData, materials); }
  getBufferArray() { return packMaterialBuffer(this.bufferData); }
}
