import { Box3, Vector3 } from 'three';
import type { SceneVolume } from '../../../src/scene/SceneVolume';

/** Uses an example's volumes, or ground fog scaled to the loaded model. */
export function sceneVolumes(
  settings: {volumes: boolean; volumeDensity: number; volumeWarp: number},
  bounds: Box3,
  authored?: SceneVolume[]
): SceneVolume[] {
  if (!settings.volumes) return [];
  let volumes = authored;
  if (!volumes) {
    const box = bounds.isEmpty() ? new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1)) : bounds;
    const extent = box.getSize(new Vector3());
    const size = Math.max(extent.x, extent.y, extent.z, 1e-3);
    const center = box.getCenter(new Vector3());
    const ground = box.min.y;
    // Reciprocal density/falloff keep optical depth constant across model units.
    volumes = [{
      density: 0.8 / size,
      bounds: {
        min: [center.x - size, ground - 0.05 * size, center.z - size],
        max: [center.x + size, ground + 0.6 * size, center.z + size]
      },
      baseHeight: ground,
      heightFalloff: 5 / size,
      color: [0.78, 0.84, 1],
      anisotropy: 0.25,
      noise: { size: [0.35 * size, 0.12 * size, 0.35 * size], coverage: 0.65, softness: 0.35 },
      edgeFade: 0.25
    }];
  }
  return volumes.map((volume) => ({
    ...volume,
    density: volume.density * settings.volumeDensity,
    ...(volume.noise ? { noise: { ...volume.noise, warp: settings.volumeWarp } } : {})
  }));
}
