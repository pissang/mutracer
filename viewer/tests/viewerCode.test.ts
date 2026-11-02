import ts from 'typescript';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

// The store reads the URL hash on import.
vi.hoisted(() => { (globalThis as { location?: unknown }).location ??= { hash: '' }; });

import { DEFAULT_SETTINGS, type Settings } from '../src/store';
import { formatForAgent, generateCode, type CodeSnapshot } from '../src/engine/codeSnippet';

const snapshot = (settings: Partial<Settings> = {}, extra: Partial<CodeSnapshot> = {}): CodeSnapshot => ({
  settings: { ...DEFAULT_SETTINGS, ...settings },
  webgpu: true,
  modelUrl: 'https://example.com/model.glb',
  environmentUrl: 'https://example.com/env.hdr',
  camera: { projection: 'perspective', fov: 35, halfHeight: 0, zoom: 1, near: 0.01, far: 100, position: [3, 2, 5], target: [0, 0.5, 0], up: [0, 1, 0] },
  focusDistance: 5,
  metersPerUnit: 1,
  groundSize: 12,
  grounded: { height: 1.6, radius: 32 },
  studioLights: [{ name: 'Key', intensity: 4, width: 1, height: 2, position: [1, 2, 3], quaternion: [0, 0, 0, 1] }],
  animation: null,
  ...extra
});

function syntaxErrors(code: string) {
  const result = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('viewer code snippet', () => {
  it('uses the library sky with the selected solar time and grounded background', () => {
    const code = generateCode(snapshot({ envId: 'sky', skyTime: 9, background: 'grounded' }, { environmentUrl: null }));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).toContain('new ProceduralSky({ time: 9 })');
    expect(code).toContain('scene, camera, controls, environment');
    expect(code).toContain('texture: environment');
    expect(code).not.toContain('HDRLoader');
    expect(code).not.toContain('./environment.hdr');
  });
  it('recreates metadata lights without adding an HDRI to an emissive scene', () => {
    const code = generateCode(snapshot({ envId: 'model', background: 'grounded' }, {
      environmentUrl: null, blackEnvironment: true,
      metadataLights: [{ color: [8, 4, 2], intensity: 1, position: [1, 3, 0], target: [0, 1, 0] }]
    }));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).not.toContain('HDRLoader');
    expect(code).not.toContain('texture: environment');
    expect(code).toContain('new THREE.DirectionalLight(new THREE.Color(8, 4, 2), 1)');
    expect(code).toContain('light.position.set(1, 3, 0)');
    expect(code).toContain('light.target.position.set(0, 1, 0)');
  });
  it('leaves library defaults out', () => {
    const code = generateCode(snapshot({ toneMapping: 'agx', exposure: 1, denoise: false, groundOpacity: 1 }));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).not.toContain('engine.display,');
    expect(code).toContain("loadAsync('https://example.com/model.glb')");
    expect(code).toContain('final: { maxSamples: 64, bounces: 6, resolutionScale: 0.5 }');
    expect(code).not.toContain(', Sync }');
  });

  it('writes changed display, render and denoiser settings', () => {
    const code = generateCode(snapshot({
      exposure: 1.5, toneMapping: 'aces', groundOpacity: 0.5, samplingPattern: 'zsobol',
      denoise: true, denoiseModel: 'jnlm', denoiseWhileConverging: true, jnlmStrength: 2
    }));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).toContain("Object.assign(engine.display, { toneMapping: 'aces', toneMappingExposure: 1.5, shadowCatcherAlpha: 0.5 })");
    expect(code).toContain("denoiser: { schedule: 'progressive', type: 'jnlm', strength: 2 }");
    expect(code).toContain("denoiser: { schedule: 'every-sample', type: 'jnlm', strength: 2 }");
    expect(code).toContain('coalesceSceneUpdates: true');
  });

  it('declares AOVs on both renders and retains the display mapping', () => {
    const code = generateCode(snapshot({output: 'depth', aovDepthFar: 20}));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).toContain("channel: 'depth'");
    expect(code).toMatch(/aovDepthRange: \[0,\s*20\]/);
    expect(code.match(/aovs: \[/g)).toHaveLength(2);
    expect(code).toContain("preview: { aovs: ['depth'],");
    expect(code).not.toContain("aovs: ['depth',");
  });

  it('omits preview AOV passes for beauty and only integrates reflectance when displayed', () => {
    const beauty = generateCode(snapshot({output: 'final'}));
    expect(syntaxErrors(beauty)).toEqual([]);
    expect(beauty).not.toContain('aovs:');
    for (const output of ['diffuseAlbedo', 'specularAlbedo'] as const) {
      const code = generateCode(snapshot({output}));
      expect(syntaxErrors(code)).toEqual([]);
      expect(code).toContain(`preview: { aovs: ['${output}'],`);
    }
  });

  it('preserves caustics in generated final and preview renders', () => {
    const code=generateCode(snapshot({caustics:true,previewEnabled:true}));
    expect(syntaxErrors(code)).toEqual([]);
    expect(code.match(/caustics: \{ lightTracing: true, photonMapping: false \}/g)).toHaveLength(2);
  });

  it('uses JNLM on WebGL like the viewer', () => {
    const code = generateCode(snapshot({ denoise: true, denoiseWhileConverging: false }, { webgpu: false }));
    expect(code).toContain("denoiser: { type: 'jnlm' }");
    expect(generateCode(snapshot({ denoise: true, denoiseWhileConverging: false }))).toContain("denoiser: { type: 'oidn' }");
  });

  it('preserves the HDR display preference in generated code', () => {
    for (const webgpu of [true, false]) {
      const code = generateCode(snapshot({ hdrOutputEnabled: true, groundOpacity: 1 }, { webgpu }));
      expect(syntaxErrors(code)).toEqual([]);
      expect(code).toContain('Object.assign(engine.display, { hdrOutputEnabled: true })');
    }
  });

  it('covers studio lighting, backgrounds, lens, orthographic views and animation', () => {
    const studio = generateCode(snapshot({ lighting: 'studio', background: 'environment' }));
    expect(syntaxErrors(studio)).toEqual([]);
    expect(studio).toContain('new THREE.RectAreaLight');
    expect(studio).toContain('[4, 1, 2, 1, 2, 3, 0, 0, 0, 1], // Key');
    expect(studio).not.toContain('Placeholders');
    expect(studio).toContain('scene.environmentIntensity = 0.1;');
    expect(studio).not.toContain('scene.background = ambient;');
    expect(studio).not.toContain('HDRLoader');

    const grounded = generateCode(snapshot({ background: 'grounded', envIntensity: 2, envRotation: -90 }));
    expect(grounded).toContain('mutracerGroundedSkybox = { texture: environment, height: 1.6, radius: 32, intensity: scene.environmentIntensity, rotation: scene.environmentRotation.y }');
    expect(grounded).toContain('scene.environmentRotation.y = THREE.MathUtils.degToRad(270);');
    expect(grounded).toContain('scene.environmentIntensity = 2;');
    expect(grounded).not.toContain('setDataType');

    const lens = generateCode(snapshot({ fStop: 2.8, previewEnabled: false }, { animation: { clip: 1, speed: 2, loop: false } }));
    expect(syntaxErrors(lens)).toEqual([]);
    expect(lens).toContain('camera.focus = 5;');
    expect(lens).toContain('sync: [sync, lens, animation]');
    expect(lens).toContain('preview: false');
    expect(lens).toContain('action.setLoop(THREE.LoopOnce, 1);');

    const ortho = generateCode(snapshot({ fStop: 2.8 }, {
      modelUrl: null,
      camera: { projection: 'orthographic', fov: 0, halfHeight: 2, zoom: 1.5, near: 0.1, far: 50, position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] }
    }));
    expect(syntaxErrors(ortho)).toEqual([]);
    expect(ortho).toContain('new THREE.OrthographicCamera(-1, 1, 2, -2, 0.1, 50)');
    expect(ortho).toContain('camera.right = camera.top * aspect;');
    expect(ortho).not.toContain('fStop');
    expect(ortho).toContain("'./model.glb'");
    expect(ortho).toContain('// Placeholders to replace: ./model.glb.');
    expect(generateCode(snapshot({}, { webgpu: false }))).toContain('WebGL 2 backend');
  });

  it('wraps the code for agents with the viewer state', () => {
    const code = generateCode(snapshot());
    const markdown = formatForAgent(code, {
      modelName: 'Toy Car', credit: null, viewerUrl: 'https://example.com/viewer/#model=toycar', changedSettings: { exposure: 1.5 }
    });
    expect(markdown).toContain('- Model: Toy Car\n');
    expect(markdown).toContain('#model=toycar');
    expect(markdown).toContain('"exposure": 1.5');
    expect(markdown).toContain('```js\n' + code.trimEnd() + '\n```');
    expect(formatForAgent(code, { modelName: null, credit: null, viewerUrl: null, changedSettings: {} })).not.toContain('```json');
  });
});

async function generatedScene(settings:Partial<Settings>) {
  const source=new THREE.DataTexture(new Float32Array([2,1,.5,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  class Loader {async loadAsync() {return source;}}
  const code=generateCode(snapshot(settings));
  const body=code.slice(code.indexOf('const scene ='),code.indexOf('const gltf ='));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const scene:THREE.Scene=await new AsyncFunction('THREE','HDRLoader',`${body}\nreturn scene;`)(THREE,Loader);
  return {scene,source};
}

it('generates lighting parameters and leaves HDR pixels and environment backgrounds intact',async () => {
  const {scene,source}=await generatedScene({lighting:'environment',background:'environment',envIntensity:2,envRotation:-90});
  expect(scene.environment).toBe(source); expect(scene.environmentIntensity).toBe(2);
  expect(scene.environmentRotation.y).toBeCloseTo(Math.PI*1.5); expect(scene.background).toBeNull();
  expect(source.image.data).toEqual(new Float32Array([2,1,.5,1]));
});

it('generates matching Grounded parameters and resets studio orientation',async () => {
  const {scene,source}=await generatedScene({lighting:'environment',background:'grounded',envIntensity:.5,envRotation:90});
  expect(scene.userData.mutracerGroundedSkybox).toMatchObject({texture:source,intensity:.5,rotation:Math.PI/2,height:1.6,radius:32});
  const studio=await generatedScene({lighting:'studio',background:'environment',studioAmbient:.2,envIntensity:3,envRotation:90});
  expect(studio.scene.environmentIntensity).toBe(.2); expect(studio.scene.environmentRotation.y).toBe(0);
});
