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
  expect(rayTrace({hasDisplacement:false,mnee:true,mneeMethod:'sms'})).toBe(plain);
  expect(fragment(true,-1,'sms').main).toBe(glsl);
  const options = {casterSphere:[0,0,0,1],viewProjection:new Float32Array(16),photons:1,batch:0,cameraScale:1,mnee:true};
  expect(new Uint32Array(packCausticLightUniform(options))[22]).toBe(0);
  registerMnee();
  expect(rayTrace({hasDisplacement:false,mnee:false})).toBe(plain);
  expect(fragment(false).main).toBe(glsl);
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
