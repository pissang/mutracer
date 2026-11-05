import { openPbrSchema } from '../scene/openPbrSchema.js';
import { materialParametersEqual, materialTexturesChanged } from './materialComparison.generated.js';
export { materialParametersEqual } from './materialComparison.generated.js';
import Mesh from '../scene/Mesh.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import type Geometry from '../scene/Geometry.js';
import OpenPBRMaterial, { materialTextureKeys } from '../scene/OpenPBRMaterial.js';
import Texture from '../scene/Texture.js';
import type { Scene, SceneBackground, SceneLight } from '../scene/Scene.js';
import { SceneChangeTracker, type SceneSnapshotAdapter } from './sceneChangeCore.js';

export interface SceneChanges {
  meshes: 'none' | 'incremental' | 'full';
  transforms: Mesh[];
  colors: InstancedMesh[];
  geometries: Geometry[];
  materials: OpenPBRMaterial[];
  lights: boolean;
  background: boolean;
}

/** Small scalar/identity snapshots for lights, backgrounds and texture metadata. */
export function snapshotFields(object: object): unknown[] {
  const values: unknown[] = [object];
  for (const key of Object.keys(object)) {
    const value = (object as Record<string, unknown>)[key];
    values.push(key);
    if (value instanceof Texture) values.push(...snapshotTexture(value));
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      values.push(...Array.from(value as ArrayLike<number>));
    } else values.push(value);
  }
  return values;
}

function snapshotTexture(texture: Texture | undefined): unknown[] {
  return texture ? [texture, texture.version, texture.image, texture.flipY,
    texture.uvScale, texture.uvOffset, texture.uvChannel, texture.wrapS, texture.wrapT, texture.colorSpace] : [undefined];
}

export function snapshotsEqual(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

function backgroundSnapshot(background: SceneBackground | undefined) {
  if (background instanceof Texture) return snapshotTexture(background);
  if (Array.isArray(background)) return [background, ...background];
  return background ? snapshotFields(background) : [undefined];
}

function captureMaterialTextures(material: OpenPBRMaterial, out: unknown[]) {
  let i = 0;
  for (const key of materialTextureKeys) {
    const texture = material[key];
    if (typeof texture === 'number') continue;
    if (!texture) { out[i++] = undefined; continue; }
    out[i++] = texture; out[i++] = texture.version; out[i++] = texture.image;
    out[i++] = texture.flipY; out[i++] = texture.uvScale; out[i++] = texture.uvOffset;
    out[i++] = texture.uvChannel; out[i++] = texture.wrapS; out[i++] = texture.wrapT; out[i++] = texture.colorSpace;
  }
  out.length = i;
}

// Texture references and metadata have their own snapshot.
const parameterKeys = openPbrSchema.filter(field => field.type !== 'texture').map(field => field.key);

export function snapshotMaterialParameters(material: OpenPBRMaterial, previous?: readonly unknown[]) {
  return parameterKeys.map((key, index) => {
    const value = material[key];
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const array = value as ArrayLike<number>, prior = previous?.[index];
      if (Array.isArray(prior) && prior.length === array.length) {
        let equal = true;
        for (let i = 0; i < array.length; i++) if (!Object.is(array[i], prior[i])) { equal = false; break; }
        if (equal) return prior;
      }
      return Array.from(array);
    }
    return value;
  });
}

interface MaterialSnapshot { aovId: number; values: readonly unknown[]; textures: unknown[]; }

// Web values may be loosely typed JS; the generated comparisons keep their
// Object.is and array semantics. Detection rules live in sceneChangeCore.
const webAdapter: SceneSnapshotAdapter<SceneLight, SceneBackground, MaterialSnapshot, unknown[], unknown[]> = {
  validateMesh: mesh => { if (mesh instanceof InstancedMesh) mesh.validate(); },
  captureMaterial: (material, previous, retired) => {
    const item = retired ?? { aovId: material.aovId, values: [], textures: [] };
    item.aovId = material.aovId;
    item.values = snapshotMaterialParameters(material as OpenPBRMaterial, previous?.values);
    captureMaterialTextures(material as OpenPBRMaterial, item.textures);
    return item;
  },
  materialMatches: (material, snapshot) => material.aovId === snapshot.aovId && materialParametersEqual(material as OpenPBRMaterial, snapshot.values) &&
    !materialTexturesChanged(material as OpenPBRMaterial, snapshot.textures),
  captureLight: light => snapshotFields(light),
  lightsEqual: snapshotsEqual,
  captureBackground: backgroundSnapshot,
  backgroundsEqual: snapshotsEqual
};

/** Detects edits without accepting them until the pipeline has received the scene. */
export class SceneChangeDetector {
  private _tracker = new SceneChangeTracker(webAdapter);
  detect(scene: Scene): SceneChanges {
    return this._tracker.detect(scene) as SceneChanges;
  }
  commit() { this._tracker.commit(); }
  reset() { this._tracker.reset(); }
}
