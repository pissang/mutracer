import OpenPBRMaterial, { materialGeometryKeys, materialParamKeys, materialTextureKeys } from '../scene/OpenPBRMaterial.js';
import Texture from '../scene/Texture.js';
import { colorLuminance } from './lightSampling.js';
import { materialEmission } from './materialEmission.js';

export type MaterialUpdateLevel = 'params' | 'emission' | 'textures' | 'geometry';
interface MaterialSnapshot {
  paramKey: string;
  textureKey: string;
  geometryKey: string;
  emissive: string;
  emissiveMap: string;
}
const textureIds = new WeakMap<object, number>();
let nextTextureId = 1;
function textureKey(texture: Texture | undefined) {
  if (!texture) return '-';
  if (!textureIds.has(texture)) textureIds.set(texture, nextTextureId++);
  if (!textureIds.has(texture.image)) textureIds.set(texture.image, nextTextureId++);
  return [textureIds.get(texture), textureIds.get(texture.image), texture.version, texture.uvScale.join(','),
    texture.uvOffset.join(','), texture.uvChannel, texture.flipY, texture.wrapS, texture.wrapT, texture.colorSpace, texture.normalMapFrame].join(':');
}
function key(material: OpenPBRMaterial, keys: readonly (keyof OpenPBRMaterial)[]) {
  return JSON.stringify(keys.map(k => material[k]));
}
function snapshot(material: OpenPBRMaterial): MaterialSnapshot {
  return {
    paramKey: key(material, materialParamKeys),
    textureKey: (material.graph?.nodes.flatMap(node => Object.values(node.inputs ?? {}).map(input => input.value instanceof Texture ? textureKey(input.value) : '')).join('|') ?? '') + '|' + materialTextureKeys.map(k => { const value = material[k]; return typeof value === 'number' ? String(value) : textureKey(value); }).join('|'),
    // Height maps affect projective BLAS bounds.
    geometryKey: key(material, materialGeometryKeys) + '|' + textureKey(material.displacementMap),
    emissive: key(material, ['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor', 'unlit', 'shadowCatcher']) + '|' + textureKey(material.coatWeightMap),
    emissiveMap: textureKey(material.emissiveMap)
  };
}
export function materialIsEmissive(material: OpenPBRMaterial) {
  return !material.unlit && !material.shadowCatcher &&
    colorLuminance(materialEmission(material)) > 1e-8;
}

/** Expensive field keys are computed only when receiving changed materials. */
export class MaterialChangeTracker {
  private _snapshots = new WeakMap<OpenPBRMaterial, MaterialSnapshot>();
  capture(materials: readonly OpenPBRMaterial[]) {
    for (const material of materials) this._snapshots.set(material, snapshot(material));
  }
  classify(materials: readonly OpenPBRMaterial[]): { level: MaterialUpdateLevel; emission: boolean; emissiveMap: boolean } {
    let level: MaterialUpdateLevel = 'params';
    let emission = false;
    let emissiveMap = false;
    const ranks = { params: 0, emission: 1, textures: 2, geometry: 3 };
    for (const material of materials) {
      const previous = this._snapshots.get(material);
      const next = snapshot(material);
      const emissionChanged = !previous || previous.emissive !== next.emissive;
      emission ||= emissionChanged;
      emissiveMap ||= !previous || previous.emissiveMap !== next.emissiveMap;
      const candidate: MaterialUpdateLevel = !previous || next.geometryKey !== previous.geometryKey
        ? 'geometry' : next.textureKey !== previous.textureKey ? 'textures' : emissionChanged ? 'emission' : 'params';
      if (ranks[candidate] > ranks[level]) level = candidate;
    }
    return { level, emission, emissiveMap };
  }
}
