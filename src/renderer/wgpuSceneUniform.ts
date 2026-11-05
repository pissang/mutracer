import {matrixStorage} from '../math/storage.js';
import type {ReadonlyMathArray} from '../math/types.js';
import { getRectLightUOrV, getRectLightArea, getSphereLightArea, getSpotLightArea, getSpotLightRadiance, getLightDirection, getRigidLightFrame, validateSceneLights } from './lightsData.js';
import { CONSTANT_DIRECTIONAL_LIGHT, CONSTANT_SPHERE_LIGHT, CONSTANT_RECT_LIGHT, CONSTANT_SPOT_LIGHT } from './lightConstants.js';
import type { AnalyticLightState as AnalyticLight } from '../scene/lightState.js';
import { read } from '../math/access.js';
export const WGPU_SCENE_BUFFER_MIN_BYTES = 200;
const FIXED_LIGHT_COUNT = 64;
const PIXELS_PER_LIGHT = 6;

function makeRayTraceUniformCore(RayTraceUniformValues: ArrayBuffer) {
  // Created from https://webgpufundamentals.org/webgpu/lessons/resources/wgsl-offset-computer.html
  const RayTraceUniformViews = {
    outputSize: new Float32Array(RayTraceUniformValues, 0, 2),
    sampleCount: new Float32Array(RayTraceUniformValues, 8, 1),
    scaleOffset: new Float32Array(RayTraceUniformValues, 16, 4),
    lightsCount: new Int32Array(RayTraceUniformValues, 32, 1),
    transmissiveOutputAlphaMin: new Float32Array(RayTraceUniformValues, 36, 1),
    jitter: new Float32Array(RayTraceUniformValues, 40, 2),
    backgroundColor: new Float32Array(RayTraceUniformValues, 48, 4),
    groundedBackgroundParams: new Float32Array(RayTraceUniformValues, 64, 4),
    groundedBackgroundCenter: new Float32Array(RayTraceUniformValues, 80, 2),
    blasOffset: new Int32Array(RayTraceUniformValues, 88, 1),
    isEmpty: new Int32Array(RayTraceUniformValues, 92, 1),
    bevel: new Int32Array(RayTraceUniformValues, 96, 1),
    dispersionWavelengths: new Int32Array(RayTraceUniformValues, 100, 1),
    envLightPmf: new Float32Array(RayTraceUniformValues, 104, 1),
    lightChoiceCount: new Int32Array(RayTraceUniformValues, 108, 1),
    lightWeightTotal: new Float32Array(RayTraceUniformValues, 112, 1),
    lightSamplingTextureWidth: new Int32Array(RayTraceUniformValues, 116, 1),
    lightChoiceTexelOffset: new Int32Array(RayTraceUniformValues, 120, 1),
    bounces: new Int32Array(RayTraceUniformValues, 124, 1),
    varianceMoments: new Int32Array(RayTraceUniformValues, 128, 1),
    adaptiveSampling: new Int32Array(RayTraceUniformValues, 132, 1),
    clamping: new Float32Array(RayTraceUniformValues, 136, 1),
    directLightCandidates: new Int32Array(RayTraceUniformValues, 140, 1),
    backgroundFlags: new Int32Array(RayTraceUniformValues, 144, 1),
    loopUnrollGuard: new Uint32Array(RayTraceUniformValues, 148, 1),
    sceneFeatureFlags: new Uint32Array(RayTraceUniformValues, 152, 1),
    sequenceSeed: new Uint32Array(RayTraceUniformValues, 156, 1),
    zSobolLogSPP: new Uint32Array(RayTraceUniformValues, 160, 1),
    sampleSequenceOffset: new Uint32Array(RayTraceUniformValues, 164, 1),
    // Shadow-catcher light table, relative to lightChoiceTexelOffset.
    shadowCatcherChoiceOffset: new Int32Array(RayTraceUniformValues, 168, 1),
    shadowCatcherChoiceCount: new Int32Array(RayTraceUniformValues, 172, 1),
    environmentRotation: new Float32Array(RayTraceUniformValues, 176, 16),
    backgroundMapTransform: new Float32Array(RayTraceUniformValues, 240, 4),
    backgroundMapRotation: new Float32Array(RayTraceUniformValues, 256, 16)
  };
  // Fixed runtime trip bounds discourage thin-film loop unrolling. Keep 4 for
  // 2 polarizations/substrates and 3 channels, independent of BSDF budgets.
  RayTraceUniformViews.loopUnrollGuard[0] = 4;
  RayTraceUniformViews.environmentRotation.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  RayTraceUniformViews.backgroundMapRotation.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  RayTraceUniformViews.backgroundMapTransform.set([1,0,1,0]);
  RayTraceUniformViews.bevel[0] = 1;
  RayTraceUniformViews.dispersionWavelengths[0] = 3;
  return {
    buffer: RayTraceUniformValues,
    views: RayTraceUniformViews
  };
}
export function makeRayTraceUniform() { return makeRayTraceUniformCore(new ArrayBuffer(320)); }

export function packWgpuAnalyticLights(
  lights: AnalyticLight[],
  texturesIndices: number[],
  selectionPmfs: number[],
  iesProfileTexelOffset: (index: number) => number | undefined
) {
  validateSceneLights(lights);
  const numLights = lights.length;
  if (numLights > FIXED_LIGHT_COUNT) {
    console.warn(
      `Too many lights, only the first ${FIXED_LIGHT_COUNT} lights will be used.`
    );
  }
  const data = new Float32Array(numLights * PIXELS_PER_LIGHT * 4);

  function packVec3<T extends ReadonlyMathArray>(idx: number, v: T) {
    for (let i = 0; i < 3; i++) {
      data[i + idx * 4] = read(v, i);
    }
  }

  const lightTypeConstants = {
    DirectionalLight: CONSTANT_DIRECTIONAL_LIGHT,
    SphereLight: CONSTANT_SPHERE_LIGHT,
    RectLight: CONSTANT_RECT_LIGHT,
    SpotLight: CONSTANT_SPOT_LIGHT
  };

  for (let i = 0; i < numLights; i++) {
    const light = lights[i];
    const matrix = matrixStorage(light.transform);
    const color = light.color;
    const intensity = light.intensity;
    const off = i * PIXELS_PER_LIGHT;
    packVec3(
      off,
      [matrix[12], matrix[13], matrix[14]]
    );
    data[off * 4 + 3] = lightTypeConstants[light.type];
    // emission
    const emissionScale =
      light.type === 'SpotLight' ? getSpotLightRadiance(light) : intensity;
    packVec3(off + 1, [
      color[0] * emissionScale,
      color[1] * emissionScale,
      color[2] * emissionScale
    ]);
    if (light.type === 'RectLight') {
      data[(off + 1) * 4 + 3] = getRectLightArea(light);
      packVec3(off + 2, getRectLightUOrV(light, 0));
      data[(off + 2) * 4 + 3] = light.spread;
      packVec3(off + 3, getRectLightUOrV(light, 1));
    } else if (light.type === 'SphereLight') {
      data[(off + 1) * 4 + 3] = getSphereLightArea(light);
      data[(off + 2) * 4 + 3] = light.radius;
    } else if (light.type === 'SpotLight') {
      data[(off + 1) * 4 + 3] = getSpotLightArea(light);
      packVec3(off + 2, getLightDirection(light));
      data[(off + 2) * 4 + 3] = light.radius;
      packVec3(off + 3, [
        Math.cos((light.outerAngle * Math.PI) / 180),
        Math.cos((Math.min(light.innerAngle, light.outerAngle) * Math.PI) / 180),
        0
      ]);
    } else if (light.type === 'DirectionalLight') {
      packVec3(off + 2, getLightDirection(light));
    }
    data[(off + 3) * 4 + 3] = light.type === 'SpotLight'
      ? iesProfileTexelOffset(i) ?? -1
      : texturesIndices[i] ?? -1;
    data[(off + 4) * 4] = selectionPmfs[i] ?? 0;
    packVec3(off + 5, getRigidLightFrame(light).x);
  }

  return data;
}
