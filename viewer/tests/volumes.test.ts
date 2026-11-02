import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { packVolumes } from '../../src/renderer/volumeData';
import { MODEL_PRESETS } from '../src/engine/presets';
import { sceneVolumes } from '../src/engine/volumes';

const settings = { volumes: true, volumeDensity: 1, volumeWarp: 0.5 };
const bounds = new Box3(new Vector3(-2, 0, -1), new Vector3(2, 3, 1));

describe('viewer volumes', () => {
  it('supplies valid volumes to every example and imported models', () => {
    for (const preset of [...MODEL_PRESETS, undefined]) {
      const volumes = sceneVolumes(settings, bounds, preset?.volumes);
      expect(volumes.length, preset?.id ?? 'imported model').toBeGreaterThan(0);
      expect(packVolumes(volumes).count).toBe(volumes.length);
    }
  });

  it('keeps automatic fog at the model base with the same optical depth across scales', () => {
    const original = sceneVolumes(settings, bounds)[0];
    const scale = 100;
    const translation = new Vector3(10, 20, -30);
    const scaled = new Box3(bounds.min.clone().multiplyScalar(scale).add(translation), bounds.max.clone().multiplyScalar(scale).add(translation));
    const volume = sceneVolumes(settings, scaled)[0];
    expect(volume.density * scale).toBeCloseTo(original.density);
    expect(volume.heightFalloff! * scale).toBeCloseTo(original.heightFalloff!);
    expect(volume.baseHeight).toBe(translation.y);
    for (let axis = 0; axis < 3; axis++) {
      expect(volume.bounds.min[axis]).toBeCloseTo(original.bounds.min[axis] * scale + translation.getComponent(axis));
      expect(volume.bounds.max[axis]).toBeCloseTo(original.bounds.max[axis] * scale + translation.getComponent(axis));
      expect(volume.noise!.size[axis]).toBeCloseTo(original.noise!.size[axis] * scale);
    }
  });

  it('applies density and warp without changing authored volumes', () => {
    const authored = structuredClone(MODEL_PRESETS.find((preset) => preset.id === 'halloween')!.volumes!);
    const snapshot = structuredClone(authored);
    const volumes = sceneVolumes({ ...settings, volumeDensity: 2, volumeWarp: 1.5 }, bounds, authored);
    volumes.forEach((volume, i) => {
      expect(volume).toEqual({ ...authored[i], density: authored[i].density * 2, noise: { ...authored[i].noise, warp: 1.5 } });
    });
    expect(authored).toEqual(snapshot);
    expect(sceneVolumes(settings, bounds, [])).toEqual([]);
  });

  it('disables both authored and automatic fog and allows zero density', () => {
    const authored = MODEL_PRESETS.find((preset) => preset.volumes)!.volumes;
    for (const volumes of [undefined, authored]) {
      expect(sceneVolumes({ ...settings, volumes: false }, bounds, volumes)).toEqual([]);
      expect(sceneVolumes({ ...settings, volumeDensity: 0 }, bounds, volumes).every((volume) => volume.density === 0)).toBe(true);
    }
  });

  it('keeps empty and flat model bounds valid', () => {
    for (const box of [new Box3(), new Box3(new Vector3(), new Vector3()), new Box3(new Vector3(-1, 0, -1), new Vector3(1, 0, 1))]) {
      expect(packVolumes(sceneVolumes(settings, box)).count).toBe(1);
    }
  });
});
