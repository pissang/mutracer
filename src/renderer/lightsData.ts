import {matrixStorage} from '../math/storage.js';
import type { SceneLightState as NativeSceneLight, AnalyticLightState as NativeAnalyticLight } from '../scene/lightState.js';
import { read, write } from '../math/access.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import SphereLight from '../scene/SphereLight.js';
import type RectLight from '../scene/RectLightState.js';
import SpotLight from '../scene/SpotLight.js';
import DiskLight from '../scene/DiskLight.js';
import CylinderLight from '../scene/CylinderLight.js';
type AnalyticLight = NativeAnalyticLight | DiskLight | CylinderLight;
type SceneLight = NativeSceneLight | DiskLight | CylinderLight;

export { CONSTANT_DIRECTIONAL_LIGHT, CONSTANT_SPHERE_LIGHT, CONSTANT_RECT_LIGHT, CONSTANT_SPOT_LIGHT, CONSTANT_DISK_LIGHT, CONSTANT_CYLINDER_LIGHT } from './lightConstants.js';
import { CONSTANT_DIRECTIONAL_LIGHT, CONSTANT_SPHERE_LIGHT, CONSTANT_RECT_LIGHT, CONSTANT_SPOT_LIGHT, CONSTANT_DISK_LIGHT, CONSTANT_CYLINDER_LIGHT } from './lightConstants.js';

export function packLightsData(
  lights: (DirectionalLight | RectLight | SphereLight | SpotLight | DiskLight | CylinderLight)[],
  texturesIndices: number[],
  selectionPmf: (index: number) => number | undefined,
  selectionCdf: (index: number) => number | undefined,
  iesProfileTexelOffset: (index: number) => number | undefined
) {
  validateSceneLights(lights);
  const numLights = lights.length;
  const PIXELS_PER_LIGHT = 6;
  const data = new Float32Array(numLights * PIXELS_PER_LIGHT * 4);

  function packVec3(idx: number, v: number[] | Float32Array) {
    for (let i = 0; i < 3; i++) {
      data[i + idx * 4] = read(v, i);
    }
  }

  for (let i = 0; i < numLights; i++) {
    const light = lights[i];
    const color = light.color;
    const intensity = light.intensity;
    const off = i * PIXELS_PER_LIGHT;
    packVec3(
      off,
      [read(light.transform, 12), read(light.transform, 13), read(light.transform, 14)]
    );
    data[off * 4 + 3] = selectionPmf(i) ?? 1 / Math.max(numLights, 1);
    // emission
    const emissionScale = light.type === 'SpotLight' ? getSpotLightRadiance(light)
      : light.type === 'DiskLight' ? getAreaLightRadiance(intensity, getDiskLightArea(light), light.normalize)
      : light.type === 'CylinderLight' ? getAreaLightRadiance(intensity, getCylinderLightArea(light), light.normalize)
      : intensity;
    packVec3(off + 1, [
      color[0] * emissionScale,
      color[1] * emissionScale,
      color[2] * emissionScale
    ]);
    data[(off + 1) * 4 + 3] = selectionCdf(i) ?? (i + 1) / numLights;
    if (light.type === 'RectLight') {
      packVec3(off + 2, getRectLightUOrV(light, 0));
      data[(off + 2) * 4 + 3] = light.spread;
      packVec3(off + 3, getRectLightUOrV(light, 1));
      data[(off + 3) * 4 + 3] = texturesIndices[i] ?? -1;
      packVec3(off + 4, [
        light.spread,
        getRectLightArea(light),
        CONSTANT_RECT_LIGHT
      ]);
    } else if (light.type === 'SphereLight') {
      packVec3(off + 4, [
        light.radius,
        getSphereLightArea(light),
        CONSTANT_SPHERE_LIGHT
      ]);
    } else if (light.type === 'DiskLight') {
      const frame = getRigidLightFrame(light);
      packVec3(off + 2, frame.x.map(value => value * light.radius));
      packVec3(off + 3, frame.y.map(value => value * -light.radius));
      packVec3(off + 4, [light.radius, getDiskLightArea(light), CONSTANT_DISK_LIGHT]);
    } else if (light.type === 'CylinderLight') {
      const frame = getRigidLightFrame(light);
      packVec3(off + 2, frame.x.map(value => value * light.length));
      packVec3(off + 3, frame.y.map(value => value * light.radius));
      packVec3(off + 4, [light.radius, getCylinderLightArea(light), CONSTANT_CYLINDER_LIGHT]);
    } else if (light.type === 'SpotLight') {
      packVec3(off + 2, getLightDirection(light));
      packVec3(off + 3, [
        Math.cos((light.outerAngle * Math.PI) / 180),
        Math.cos((Math.min(light.innerAngle, light.outerAngle) * Math.PI) / 180),
        0
      ]);
      data[(off + 3) * 4 + 3] = iesProfileTexelOffset(i) ?? -1;
      packVec3(off + 4, [
        light.radius,
        getSpotLightArea(light),
        CONSTANT_SPOT_LIGHT
      ]);
    } else if (light.type === 'DirectionalLight') {
      packVec3(off + 2, getLightDirection(light));
      packVec3(off + 4, [0, 0, CONSTANT_DIRECTIONAL_LIGHT]);
    }
    packVec3(off + 5, getRigidLightFrame(light).x);
  }

  return data;
}

export function getRigidLightFrame(light: AnalyticLight) {
  const m = matrixStorage(light.transform);
  const normalize = (v: number[], fallback: number[]): number[] => {
    const length = Math.hypot(read(v, 0), read(v, 1), read(v, 2));
    return length > 1e-12 ? [read(v, 0)/length, read(v, 1)/length, read(v, 2)/length] : fallback;
  };
  const z = normalize([read(m, 8),read(m, 9),read(m, 10)], [0,0,1]);
  const projection = read(m, 0)*read(z, 0) + read(m, 1)*read(z, 1) + read(m, 2)*read(z, 2);
  let x: number[] = [read(m, 0)-projection*read(z, 0),read(m, 1)-projection*read(z, 1),read(m, 2)-projection*read(z, 2)];
  if (Math.hypot(...x) <= 1e-12) x = Math.abs(read(z, 1)) < .99 ? [read(z, 2),0,-read(z, 0)] : [1,0,0];
  x = normalize(x, [1,0,0]);
  const y: number[] = [read(z, 1)*read(x, 2)-read(z, 2)*read(x, 1), read(z, 2)*read(x, 0)-read(z, 0)*read(x, 2), read(z, 0)*read(x, 1)-read(z, 1)*read(x, 0)];
  return { x, y, direction: [-read(z, 0) || 0,-read(z, 1) || 0,-read(z, 2) || 0] as number[] };
}
export function getLightDirection(light: AnalyticLight) { return getRigidLightFrame(light).direction; }
export function getRectLightUOrV(light: RectLight, uOrV: 0 | 1) {
  const frame = getRigidLightFrame(light), axis = uOrV ? frame.y : frame.x;
  const dimensions = matrixStorage(light.size);
  const size = dimensions[uOrV] * (uOrV ? -1 : 1);
  return [read(axis, 0)*size,read(axis, 1)*size,read(axis, 2)*size];
}

export function getRectLightArea(light: RectLight) {
    const size = matrixStorage(light.size);
    return size[0] * size[1];
}

export function getSphereLightArea(light: SphereLight) {
    return 4 * Math.PI * light.radius ** 2;
}

export function getSpotLightArea(light: SpotLight) {
    return 4 * Math.PI * light.radius ** 2;
}

export function getDiskLightArea(light: DiskLight) { return Math.PI * light.radius ** 2; }
export function getCylinderLightArea(light: CylinderLight) { return 2 * Math.PI * light.radius * light.length; }
export function getAreaLightRadiance(intensity: number, area: number, normalize: boolean) {
  return normalize ? intensity / Math.max(area, 1e-8) : intensity;
}

export function getSpotLightRadiance(light: SpotLight) {
    // A zero-radius spot is a point emitter. Its stored emission is luminous
    // intensity (cd), and the shader applies inverse-square attenuation.
    if (light.radius === 0) return light.intensity;
    return light.intensity / (Math.PI * light.radius ** 2);
}

export function getSpotLightShapingFluxFactor(light: SpotLight) {
    const cosOuter = Math.cos((light.outerAngle * Math.PI) / 180);
    const cosInner = Math.cos((Math.min(light.innerAngle, light.outerAngle) * Math.PI) / 180);
    return 0.5 * (1 - 0.5 * (cosInner + cosOuter));
}

const warnedLights = new WeakSet<SceneLight>();
/** Sanitizes invalid mutable light values at the packing boundary; notifications are nonfatal. */
export function validateSceneLights(lights: readonly SceneLight[], onError?: (error: Error) => void) {
  for (const light of lights) {
    if (light.type === 'EnvironmentLight') continue;
    let invalid = false;
    const clamp = (value: number, min: number, max: number, fallback: number) => {
      const normalized = Math.min(max,Math.max(min,Number.isFinite(value) ? value : fallback));
      invalid ||= !Object.is(normalized,value);
      return normalized;
    };
    switch (light.type) {
      case 'AmbientLight': sanitizeIntensity(light, clamp); break;
      case 'DirectionalLight': sanitizeIntensity(light, clamp); break;
      case 'RectLight': sanitizeIntensity(light, clamp); break;
      case 'SphereLight': sanitizeIntensity(light, clamp); break;
      case 'SpotLight': sanitizeIntensity(light, clamp); break;
      case 'DiskLight': sanitizeIntensity(light, clamp); break;
      case 'CylinderLight': sanitizeIntensity(light, clamp); break;
    }
    if (light.type !== 'AmbientLight') {
      const matrix = light.transform;
      invalid = (matrix instanceof Float32Array ? sanitizeMatrix(matrix) : sanitizeMatrix(matrix)) || invalid;
    }
    if (light.type === 'RectLight') {
      // A tuple widened to number[] is copied by this native compiler. Mutate
      // each concrete storage directly so invalid edits still sanitize in place.
      const size = light.size;
      if (size instanceof Float32Array) {
        size[0] = clamp(size[0],0,Number.MAX_VALUE,1);
        size[1] = clamp(size[1],0,Number.MAX_VALUE,1);
      } else {
        size[0] = clamp(size[0],0,Number.MAX_VALUE,1);
        size[1] = clamp(size[1],0,Number.MAX_VALUE,1);
      }
      light.spread = clamp(light.spread,0,1,1);
    }
    if (light.type === 'SphereLight') light.radius = clamp(light.radius,0,Number.MAX_VALUE,1);
    if (light.type === 'DiskLight') light.radius = clamp(light.radius,Number.EPSILON,Number.MAX_VALUE,.5);
    if (light.type === 'CylinderLight') {
      light.radius = clamp(light.radius,Number.EPSILON,Number.MAX_VALUE,.5);
      light.length = clamp(light.length,Number.EPSILON,Number.MAX_VALUE,1);
      light.normalize = !!light.normalize;
      light.treatAsLine = !!light.treatAsLine;
    }
    if (light.type === 'DiskLight') light.normalize = !!light.normalize;
    if (light.type === 'SpotLight') light.radius = clamp(light.radius,0,Number.MAX_VALUE,.01);
    if (light.type === 'SpotLight') {
      light.outerAngle = clamp(light.outerAngle,Number.EPSILON,180,45);
      light.innerAngle = clamp(light.innerAngle,0,light.outerAngle,30);
    }
    if (invalid && !warnedLights.has(light)) {
      warnedLights.add(light);
      const error = new Error(`Invalid ${light.type} values were clamped.`);
      console.warn(error.message);
      onError?.(error);
    }
  }
}

function sanitizeIntensity<L extends {intensity: number; color: [number, number, number]}>(light: L,
  clamp: (value: number, min: number, max: number, fallback: number) => number) {
  light.intensity = clamp(light.intensity,0,Number.MAX_VALUE,1);
  light.color[0] = clamp(light.color[0],0,Number.MAX_VALUE,1);
  light.color[1] = clamp(light.color[1],0,Number.MAX_VALUE,1);
  light.color[2] = clamp(light.color[2],0,Number.MAX_VALUE,1);
}

function sanitizeMatrix<T extends Float32Array | number[]>(matrix: T): boolean {
  let invalid = false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(read(matrix, i))) {
    write(matrix, i, i % 5 === 0 ? 1 : 0); invalid = true;
  }
  return invalid;
}
