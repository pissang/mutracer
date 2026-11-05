import MeshState from '../scene/MeshState.js';
import MaterialState from '../scene/MaterialState.js';
import {createCanvas} from '../util/canvas.js';
import Geometry from '../scene/Geometry.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import Texture from '../scene/Texture.js';
import { copyGeometryChangeState } from '../scene/geometryChanges.js';
import { getGeometryBvh, setGeometryBvh } from './geometryBvh.js';
import type { Scene } from '../scene/Scene.js';
import type { SceneChanges } from './sceneChangeDetector.js';

/** Stable engine-owned mirrors isolate deferred GPU uploads from external edits. */
export class CommittedScene {
  private readonly copies = new WeakMap<object, any>();
  private readonly geometryVersions = new WeakMap<Geometry, number>();
  private readonly instanceVersions = new WeakMap<InstancedMesh, {transformsVersion: number; transforms: Float32Array; colorsVersion: number; colors?: Float32Array}>();
  private value?: Scene;
  private readonly copying = new WeakSet<object>();

  private copy<T>(value: T, retainGeometryBvh = false): T {
    if (!value || typeof value !== 'object') return value;
    const object = value as object;
    if ((typeof HTMLImageElement !== 'undefined' && object instanceof HTMLImageElement) || (typeof HTMLCanvasElement !== 'undefined' && object instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && object instanceof OffscreenCanvas) ||
        (typeof ImageBitmap !== 'undefined' && object instanceof ImageBitmap)) {
      const source = object as HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
      let canvas = this.copies.get(object) as HTMLCanvasElement | OffscreenCanvas | undefined;
      if (!canvas) { canvas = createCanvas(source.width, source.height); this.copies.set(object, canvas); }
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context) throw new Error('Texture snapshot context is not available.');
      context.drawImage(source, 0, 0);
      return canvas as T;
    }
    if (typeof Node !== 'undefined' && object instanceof Node) return value;
    if (value instanceof Geometry && this.geometryVersions.get(value) === value.version) return this.copies.get(value);
    if (ArrayBuffer.isView(value)) {
      const previous = this.copies.get(object);
      if (previous?.constructor === value.constructor && previous.length === (value as any).length) {
        previous.set(value); return previous;
      }
      const cloned = (value as any).slice(); this.copies.set(object, cloned); return cloned;
    }
    if (value instanceof ArrayBuffer) return value.slice(0) as T;
    let cloned = this.copies.get(object);
    if (!cloned) { cloned = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value)); this.copies.set(object, cloned); }
    if (value instanceof MeshState || value instanceof MaterialState) cloned.aovId = value.aovId;
    if (this.copying.has(object)) return cloned;
    this.copying.add(object);
    try {
      for (const key of Object.keys(value)) {
        if (value instanceof InstancedMesh && (key === 'transforms' || key === 'colors')) {
          const previous = this.instanceVersions.get(value);
          const version = key === 'transforms' ? value.transformsVersion : value.colorsVersion;
          const priorVersion = key === 'transforms' ? previous?.transformsVersion : previous?.colorsVersion;
          const array = value[key];
          if (!previous || priorVersion !== version || previous[key] !== array) {
            // Each batch owns its snapshot even when callers share source storage.
            if (!array) cloned[key] = undefined;
            else if (previous?.[key] === array && cloned[key]?.length === array.length) cloned[key].set(array);
            else cloned[key] = array.slice();
          }
        } else cloned[key] = value instanceof Texture && key === 'source' ? value.source : this.copy((value as any)[key], retainGeometryBvh);
      }
    } finally { this.copying.delete(object); }
    if (Array.isArray(value)) cloned.length = value.length;
    if (value instanceof InstancedMesh) this.instanceVersions.set(value, {
      transformsVersion: value.transformsVersion, transforms: value.transforms,
      colorsVersion: value.colorsVersion, colors: value.colors
    });
    if (value instanceof Geometry) {
      this.geometryVersions.set(value, value.version);
      // The renderer builds/refits BVHs on the committed geometry. A source
      // without a precomputed BVH must not erase that tree on every pose edit.
      // Full scene replacements cannot rely on an incremental renderer refit.
      const sourceBvh = getGeometryBvh(value);
      if (sourceBvh || !retainGeometryBvh) setGeometryBvh(cloned, sourceBvh);
      copyGeometryChangeState(value, cloned);
    }
    return cloned;
  }

  mirror<T extends object>(source: T): T { return this.copies.get(source); }

  capture(scene: Scene, changes: SceneChanges): Scene {
    if (!this.value || changes.meshes === 'full') this.value = { meshes: this.copy(scene.meshes), lights: this.copy(scene.lights), background: this.copy(scene.background) };
    else {
      for (const mesh of changes.transforms) {
        this.copy(mesh.transform);
        if (mesh instanceof InstancedMesh) this.copy(mesh, true);
      }
      for (const mesh of changes.colors) this.copy(mesh, true);
      for (const geometry of changes.geometries) this.copy(geometry, true);
      for (const material of changes.materials) this.copy(material);
      if (changes.lights) this.value.lights = this.copy(scene.lights);
      if (changes.background) this.value.background = this.copy(scene.background);
    }
    return this.value;
  }
}
