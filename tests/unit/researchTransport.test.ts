import {afterEach, expect, it} from 'vitest';
import rayTrace from '../../src/renderer/wgsl/rayTrace.compute';
import fragment from '../../src/renderer/glsl/rayTrace.frag';
import {packCausticLightUniform} from '../../src/renderer/causticUniform';
import {registerResearchTransport} from '../../src/renderer/researchTransport';
import {registerMnee} from '../../src/research/mnee/index';

afterEach(() => registerResearchTransport(undefined));
it('requires explicit registration and preserves disabled sources when registered', () => {
  registerResearchTransport(undefined);
  const plain = rayTrace({hasDisplacement:false}), glsl = fragment().main;
  const spectral = fragment({channelIndependentLight: true}).main;
  expect(rayTrace({hasDisplacement:false,mnee:true,mneeMethod:'sms'})).toBe(plain);
  expect(fragment(true,-1,'sms').main).toBe(glsl);
  const options = {casterSphere:[0,0,0,1],viewProjection:new Float32Array(16),photons:1,batch:0,cameraScale:1,mnee:true};
  expect(new Uint32Array(packCausticLightUniform(options))[22]).toBe(0);
  registerMnee();
  expect(rayTrace({hasDisplacement:false,mnee:false})).toBe(plain);
  expect(fragment(false).main).toBe(glsl);
  expect(fragment({channelIndependentLight: true}).main).toBe(spectral);
  expect(rayTrace({hasDisplacement:false,mnee:true})).toContain('fn mneeContribution');
  expect(fragment(true).main).toContain('vec3 mneeContribution');
  expect(new Uint32Array(packCausticLightUniform(options))[22]).toBe(1);
});

it('keeps the pipeline identity stable when an installed experiment is disabled', async () => {
  const {gpu} = await import('./shaderSourceFormattingFixture'); gpu();
  const {default: Pass, makeRayTraceUniform} = await import('../../src/renderer/WGPURayTracePass');
  const {Mesh, OpenPBRMaterial, createPlaneGeometry} = await import('../../src/main');
  const {mneeDiagnostics} = await import('../../src/research/mnee/index');
  registerResearchTransport(undefined);
  const pass = Object.assign(Object.create(Pass.prototype), {
    _meshes:[new Mesh(createPlaneGeometry(),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}))],
    _rtUniform:makeRayTraceUniform()
  });
  const settings = {bounces:8,bevel:false,dispersionWavelengths:1 as const,directLightCandidates:2,caustics:{lightTracing:true}};
  pass.setQuality(settings); const plain = pass._causticKey;
  registerMnee(); mneeDiagnostics.mnee=false;
  pass.setQuality(settings); expect(pass._causticKey).toBe(plain);
  mneeDiagnostics.mnee=true;
  pass.setQuality(settings); expect(pass._causticKey).not.toBe(plain);
  mneeDiagnostics.mnee=false;
  pass.setQuality(settings); expect(pass._causticKey).toBe(plain);
});

it('suppresses MNEE ownership while volumes is present and restores its configured state', async () => {
  const {researchTransport} = await import('../../src/renderer/researchTransport');
  const {mneeDiagnostics} = await import('../../src/research/mnee/index');
  const {Mesh, OpenPBRMaterial, createPlaneGeometry} = await import('../../src/main');
  const {vi} = await import('vitest');
  registerMnee(); mneeDiagnostics.mnee = true;
  try {
    const setShader = vi.fn();
    const pass = {_meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0}))], _mainPass: {setShader}};
    const extension = researchTransport()!;
    expect(extension.configure(pass, 'webgl').enabled).toBe(true);
    setShader.mockClear();
    expect(extension.configure(pass, 'webgl', true).enabled).toBe(false);
    expect(setShader).not.toHaveBeenCalled();
    expect(extension.configure(pass, 'webgl').enabled).toBe(true);
    expect(setShader).toHaveBeenCalledOnce();
    expect(extension.configure(pass, 'webgpu', true).enabled).toBe(false);
  } finally {mneeDiagnostics.mnee = false;}
});

it('restores shared spectral rendering after leaving an experimental connection solver', async () => {
  const {default: Pass} = await import('../../src/renderer/WebGLRayTracePass');
  const {Mesh, OpenPBRMaterial, createPlaneGeometry} = await import('../../src/main');
  const {mneeDiagnostics} = await import('../../src/research/mnee/index');
  const {vi} = await import('vitest');
  const setShader = vi.fn();
  const pass = Object.assign(Object.create(Pass.prototype), {
    _meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial({transmissionWeight: 1, transmissionDispersionScale: 1, specularRoughness: 0}))],
    _mainPass: {setShader}, _tracePasses: [{setUniform: vi.fn()}],
    _spectral: true, _shareSpectralPrefix: true
  });
  const quality = {bounces: 8, bevel: false, dispersionWavelengths: 3 as 1 | 3, directLightCandidates: 4};
  registerMnee(); mneeDiagnostics.mnee = true;
  try {
    pass.setQuality(quality);
    expect(pass.hasSharedSpectralPrefix()).toBe(false);
    mneeDiagnostics.mnee = false;
    pass.setQuality(quality);
    expect(pass.hasSharedSpectralPrefix()).toBe(true);
    expect(setShader.mock.lastCall![0].main).toBe(fragment({channelIndependentLight: true, shareSpectralPrefix: true}).main);
    quality.dispersionWavelengths = 1; pass.setQuality(quality);
    expect(pass.hasSharedSpectralPrefix()).toBe(false);
    expect(setShader.mock.lastCall![0].main).toBe(fragment({channelIndependentLight: true}).main);
    quality.dispersionWavelengths = 3; pass.setQuality(quality);
    expect(pass.hasSharedSpectralPrefix()).toBe(true);
  } finally {mneeDiagnostics.mnee = false;}
});
