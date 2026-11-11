import {expect, it, vi} from 'vitest';
import {retainedSceneParameters, sceneMaterialParameters, sceneLightListParameters, acceptSceneLighting, releaseSceneParameters, sceneTargetParameters} from '../../native/src/scene-core';
import {HEADER as H, GEOMETRY as G, MESH as M, MATERIAL as MAT, CAMERA as C, LIGHT as L, VERSION, SETTINGS as S, EXTENSION as E} from '../../native/src/layout';
import * as shaderSource from '../../src/renderer/wgpuShaderSource';
import {MATERIAL_SHADER_CAPABILITIES, LIGHT_SHADER_CAPABILITIES} from '../../src/renderer/shaderCapabilities';
import {PACKET_ENTRY as PE, PACKET_HEADER as PH, WRITE_ENTRY as WE, RESOURCE} from '../../native/src/layout';
import {materialLayoutFields} from '../../src/renderer/materialLayoutSchema';

function triangleScene() {
  const geometry = H.WORDS, mesh = geometry + G.WORDS, material = mesh + M.WORDS;
  const camera = material + MAT.WORDS, positions = camera + C.WORDS, indices = positions + 9;
  const bytes = new Uint8Array((indices + 3) * 4), u = new Uint32Array(bytes.buffer), f = new Float32Array(bytes.buffer);
  u[H.VERSION] = VERSION.SCENE; u[H.LENGTH] = bytes.length; u[H.WIDTH] = 8; u[H.HEIGHT] = 8;
  u[H.GEOMETRY_COUNT] = u[H.MESH_COUNT] = u[H.MATERIAL_COUNT] = 1;
  u[H.GEOMETRY_OFFSET] = geometry; u[H.MESH_OFFSET] = mesh; u[H.MATERIAL_OFFSET] = material;
  u[H.CAMERA_OFFSET] = camera;
  u[geometry + G.VERTEX_COUNT] = u[geometry + G.INDEX_COUNT] = 3;
  u[geometry + G.POSITION] = positions; u[geometry + G.INDICES] = indices;
  f.set([-1, -1, 0, 1, -1, 0, 0, 1, 0], positions); u.set([0, 1, 2], indices);
  f.set([.6, .3, .15], material + MAT.BASE_COLOR);
  f[material + MAT.ROUGHNESS] = .3; f[material + MAT.IOR] = 1.5; f[material + MAT.OPACITY] = 1;
  for (const slot of [MAT.MAP, MAT.NORMAL_MAP, MAT.METALLIC_ROUGHNESS_MAP, MAT.EMISSIVE_MAP]) u[material + slot] = 0xffffffff;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  f.set(identity, mesh + M.TRANSFORM); f.set(identity, camera + C.TRANSFORM);
  f[camera + C.TRANSFORM + 14] = 3; f[camera + C.FOV] = 45;
  f[camera + C.NEAR] = .1; f[camera + C.FAR] = 100; f[camera + C.ZOOM] = 1;
  f[camera + C.FOCUS_DISTANCE] = 3; f[camera + C.SENSOR_HEIGHT] = .024; f[camera + C.METERS_PER_UNIT] = 1;
  return bytes;
}

it('keeps native scalar transport and light-list edits available in the original pipeline', () => {
  const token = 4810, generate = vi.spyOn(shaderSource, 'wgpuShaderSource');
  try {
    const scene = retainedSceneParameters(triangleScene(), token);
    expect(new Uint32Array(scene.buffer)[0]).toBe(1);
    const constants = generate.mock.calls[0][0];
    const shaderCalls = generate.mock.calls.length;
    const edit = new Uint8Array(48), u = new Uint32Array(edit.buffer), f = new Float32Array(edit.buffer);
    u[0] = 1; f.set([.6, .3, .15, .3, 1, 1, 1.5], 4);
    const update = sceneMaterialParameters(edit, token);
    expect(new Uint32Array(update.buffer)[0]).toBe(1);
    const packed = new Float32Array(update.buffer, 16);
    for (const [name, capability] of [['metallic', MATERIAL_SHADER_CAPABILITIES.metal],
      ['transmission', MATERIAL_SHADER_CAPABILITIES.transmission]] as const) {
      expect(packed[materialLayoutFields().find(field => field.name === name)!.offset / 4]).toBe(1);
      expect(Number(constants.MATERIAL_CAPABILITIES) & capability).toBe(capability);
    }
    expect(generate.mock.calls.length).toBe(shaderCalls);
    // Vertex updates can make previously degenerate emissive triangles sampleable.
    expect(Number(constants.LIGHT_CAPABILITIES) & LIGHT_SHADER_CAPABILITIES.emissive)
      .toBe(LIGHT_SHADER_CAPABILITIES.emissive);

    // A retained light list can introduce types absent from the original scene.
    for (const type of ['RectLight', 'SphereLight', 'DirectionalLight', 'SpotLight'] as const) {
      const base = triangleScene();
      const edited = new Uint8Array(base.length + L.WORDS * 4);
      edited.set(base);
      const u = new Uint32Array(edited.buffer), f = new Float32Array(edited.buffer), light = base.length / 4;
      u[H.LENGTH] = edited.length; u[H.LIGHT_COUNT] = 1; u[H.LIGHT_OFFSET] = light;
      u[light + L.TYPE] = ['RectLight', 'SphereLight', 'DirectionalLight', 'SpotLight'].indexOf(type);
      f.set([1, 1, 1], light + L.COLOR); f[light + L.INTENSITY] = 1;
      f.set([1, .5, 1], light + 5);
      f.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1], light + L.TRANSFORM);
      const lighting = sceneLightListParameters(edited, token);
      const packet = new Uint32Array(lighting.buffer);
      expect(packet[0]).toBe(VERSION.RESOURCE_WRITES);
      expect(packet[1]).toBe(3);
      expect(Number(constants.LIGHT_CAPABILITIES) & LIGHT_SHADER_CAPABILITIES[type])
        .toBe(LIGHT_SHADER_CAPABILITIES[type]);
      expect(generate.mock.calls.length).toBe(shaderCalls);
    }
  } finally {releaseSceneParameters(token); vi.restoreAllMocks();}
});


function materialPatch(scene: Uint8Array) {
  const source = new Uint32Array(scene.buffer), material = source[H.MATERIAL_OFFSET];
  const patch = new Uint8Array((6 + MAT.WORDS) * 4), u = new Uint32Array(patch.buffer);
  u.set([2, 1, 0, 0, 0, 6]); u.set(source.subarray(material, material + MAT.WORDS), 6);
  return patch;
}
function packetResource(packet: Uint8Array, id: number, write = false) {
  const u = new Uint32Array(packet.buffer), stride = write ? WE.WORDS : PE.WORDS;
  for (let i = 0; i < u[PH.COUNT]; i++) {
    const o = PH.WORDS + i * stride;
    if (u[o] === id) {
      const offset = u[o + (write ? WE.BYTE_OFFSET : PE.BYTE_OFFSET)], length = u[o + PE.LENGTH];
      return packet.slice(offset, offset + length);
    }
  }
  return undefined;
}
it('refreshes zero/nonzero emission sampling and stages material acceptance', () => {
  const scene = triangleScene(), token = 4830;
  const material = new Uint32Array(scene.buffer)[H.MATERIAL_OFFSET];
  new Float32Array(scene.buffer).set([1, 1, 1], material + MAT.EMISSION_COLOR);
  try {
    const initial = retainedSceneParameters(scene, token);
    const patch = materialPatch(scene), floats = new Float32Array(patch.buffer);
    floats[6 + MAT.EMISSION_LUMINANCE] = 2;
    const lit = sceneMaterialParameters(patch, token);
    expect(new Uint32Array(lit.buffer)[0]).toBe(VERSION.RESOURCE_WRITES);
    expect(packetResource(lit, RESOURCE.LIGHT_SAMPLING, true)).not.toEqual(packetResource(initial, RESOURCE.LIGHT_SAMPLING));
    expect(new Uint32Array(acceptSceneLighting(token).buffer)[0]).toBe(1);
    floats[6 + MAT.EMISSION_LUMINANCE] = 0;
    const dark = sceneMaterialParameters(patch, token);
    expect(packetResource(dark, RESOURCE.LIGHT_SAMPLING, true)).toEqual(packetResource(initial, RESOURCE.LIGHT_SAMPLING));
    expect(packetResource(dark, RESOURCE.MATERIALS, true)).toEqual(packetResource(initial, RESOURCE.MATERIALS));
  } finally {releaseSceneParameters(token);}
});
it('rejects missing layer/transport support and leaves accepted parameters intact', () => {
  const scene = triangleScene(), token = 4831;
  try {
    const initial = retainedSceneParameters(scene, token);
    const patch = materialPatch(scene), f = new Float32Array(patch.buffer);
    f[6 + MAT.COAT_WEIGHT] = 0.5;
    expect(new Uint32Array(sceneMaterialParameters(patch, token).buffer)[0]).toBe(2);
    f[6 + MAT.COAT_WEIGHT] = 0; f[6 + MAT.OPACITY] = 0.5;
    expect(new Uint32Array(sceneMaterialParameters(patch, token).buffer)[0]).toBe(2);
    f[6 + MAT.OPACITY] = 1;
    const unchanged = sceneMaterialParameters(patch, token);
    expect(packetResource(unchanged, RESOURCE.MATERIALS, true)).toEqual(packetResource(initial, RESOURCE.MATERIALS));
  } finally {releaseSceneParameters(token);}
});

// Exercise the target packet contract: settings must specialize the source even
// when sampling, bevel and the committed scene remain unchanged.
it('selects spectral prefix variants per target, including previews and frame inputs', () => {
  const base = triangleScene(), scene = new Uint8Array(base.length + E.WORDS * 4);
  scene.set(base);
  const u = new Uint32Array(scene.buffer), f = new Float32Array(scene.buffer);
  const material = u[H.MATERIAL_OFFSET], extension = base.length / 4;
  u[H.LENGTH] = scene.length; u[H.QUALITY_FLAGS] = 2;
  u[material + MAT.EXTENSION_COUNT] = 1; u[material + MAT.EXTENSION_OFFSET] = extension;
  u[extension + E.ID] = 15; f[extension + E.X] = 1;
  const token = 4891, generate = vi.spyOn(shaderSource, 'wgpuShaderSource');
  try {
    retainedSceneParameters(scene, token);
    expect(generate.mock.calls[0][1]).toMatchObject({channelIndependentRis: true, shareSpectralPrefix: true});
    const request = new Uint8Array((S.WORDS + 8 + C.WORDS) * 4);
    const ru = new Uint32Array(request.buffer), rf = new Float64Array(request.buffer, 0, S.WORDS / 2);
    ru[S.STRUCT_SIZE] = S.WORDS * 4; ru[S.MAX_SAMPLES] = 64;
    ru[S.SEED] = 12345; ru[S.VARIANTS] = 1;
    rf[S.BOUNCES / 2] = 6; rf[S.DIRECT_LIGHT_CANDIDATES / 2] = 2;
    rf[S.BEVEL_SAMPLES / 2] = 8; rf[S.TRANSMISSIVE_ALPHA_MIN / 2] = 1;
    ru.set([8, 8, 2, RESOURCE.SOFTWARE_SHADER], S.WORDS);
    request.set(scene.subarray(u[H.CAMERA_OFFSET] * 4, (u[H.CAMERA_OFFSET] + C.WORDS) * 4), (S.WORDS + 8) * 4);
    const target = () => sceneTargetParameters(request, token);
    expect(new Uint32Array(target().buffer, 0, 4)[1]).toBe(0); // committed three-wavelength shader
    ru[S.WORDS + 2] = 0;
    const preview = target();
    expect(new Uint32Array(preview.buffer, 0, 4)[1]).toBeGreaterThan(0);
    expect(generate.mock.calls.at(-1)![1]).toMatchObject({channelIndependentRis: true, shareSpectralPrefix: false});
    expect(target()).toEqual(preview); // same AOT cache variant
    ru[S.WORDS + 2] = 2;
    expect(new Uint32Array(target().buffer, 0, 4)[1]).toBe(0);
    ru[S.VARIANTS] = 17;
    expect(new Uint32Array(target().buffer, 0, 4)[1]).toBeGreaterThan(0);
    expect(generate.mock.calls.at(-1)![1]).toMatchObject({channelIndependentRis: true, shareSpectralPrefix: true});
    ru[S.WORDS + 2] = 0;
    target();
    expect(generate.mock.calls.at(-1)![1]).toMatchObject({channelIndependentRis: true, shareSpectralPrefix: false});
  } finally {releaseSceneParameters(token); vi.restoreAllMocks();}
});
