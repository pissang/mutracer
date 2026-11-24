import {expect, it} from 'vitest';
import {DirectionalLight, RectLight, SphereLight, SpotLight} from '../../src/main';
import {LightChoiceBuffer, type EmissiveTriangle} from '../../src/renderer/lightSampling';
import {autoDirectLightCandidates, prepareSceneLightSampling} from '../../src/renderer/sceneAssembly';
import WGPURayTracePass, {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import type {AnalyticLightState} from '../../src/renderer/analyticLightState';

function candidates(lights: AnalyticLightState[], env = 0, triangles: EmissiveTriangle[] = []) {
  const choices = new LightChoiceBuffer();
  prepareSceneLightSampling(lights, triangles, env, 1024, choices);
  return autoDirectLightCandidates(lights, choices);
}

it('counts only sampled lights and distinguishes delta emitters from area lights', () => {
  const sun = new DirectionalLight(), point = new SphereLight({radius: 0}), spot = new SpotLight({radius: 0});
  const off = new RectLight({intensity: 0});
  expect(candidates([off, sun])).toBe(1);
  expect(candidates([sun], 1)).toBe(1);
  expect(candidates([point])).toBe(1);
  expect(candidates([spot])).toBe(1);
  expect(candidates([point], 1)).toBe(4);
  expect(candidates([sun, point])).toBe(4);
  expect(candidates([new SphereLight()])).toBe(4);
  expect(candidates([], 1)).toBe(4);
  expect(candidates([])).toBe(4);
});

it('raises the budget for many analytic lights and excludes emissive geometry and mixed environments', () => {
  const lights = Array.from({length: 16}, () => new SphereLight());
  const v = new Float32Array([0, 0, 0]), uv: [number, number] = [0, 0];
  const triangle: EmissiveTriangle = {p0:v, p1:v, p2:v, uv0:uv, uv1:uv, uv2:uv,
    secondaryUv0:uv, secondaryUv1:uv, secondaryUv2:uv, materialIndex:0, area:1, samplingLuminance:1, selectionPmf:0};
  expect(candidates(lights)).toBe(8);
  expect(candidates(lights.slice(1))).toBe(4);
  expect(candidates(lights, 1)).toBe(4);
  expect(candidates(lights, 0, [triangle])).toBe(4);
  expect(candidates([new DirectionalLight()], 0, [triangle])).toBe(4);
});

it('restores numeric overrides and follows the current light budget in auto mode', () => {
  const pass = Object.create(WGPURayTracePass.prototype);
  pass._rtUniform = makeRayTraceUniform();
  const quality = {bounces: 3, bevel: false, dispersionWavelengths: 1 as const};
  for (const [setting, sceneBudget, expected] of [['auto', 1, 1], [3, 1, 3], ['auto', 8, 8], [100, 8, 16]] as const) {
    pass._autoDirectLightCandidates = sceneBudget;
    pass.setQuality({...quality, directLightCandidates: setting});
    expect(pass._rtUniform.views.directLightCandidates[0]).toBe(expected);
  }
});
