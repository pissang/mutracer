import {describe, expect, it, vi} from 'vitest';
import WGPURayTracePass, {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import {WGPUShaderCache} from '../../src/renderer/WGPUShaderCache';
import {WGPUShaderCapabilities} from '../../src/renderer/WGPUShaderCapabilities';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createPlaneGeometry} from '../../src/util/commonGeometry';
import Mesh from '../../src/scene/Mesh';

const pipeline = () => ({getBindGroupLayout: () => ({})}) as unknown as GPUComputePipeline;

function fixture() {
  const completions: (() => void)[] = [];
  let failNext = false;
  const compile = vi.fn(() => new Promise<GPUComputePipeline>((resolve, reject) => {
    const failed = failNext; failNext = false;
    completions.push(() => failed ? reject(new Error('Compilation failed')) : resolve(pipeline()));
  }));
  const device = {createShaderModule: () => ({getCompilationInfo: async () => ({messages: []})}),
    createComputePipelineAsync: compile, pushErrorScope() {}, popErrorScope: async () => null} as unknown as GPUDevice;
  const pass = Object.create(WGPURayTracePass.prototype) as any;
  const maps = new Map<object, {data: object}>();
  Object.assign(pass, {_device: device, _shaderCache: new WGPUShaderCache(device), _rtUniform: makeRayTraceUniform(),
    _pendingGeometryUpdates: new Set(), _dirtyColorMeshes: new Set(), _traceVariants: new Map(), _traceModules: new Map(), _targetTransport: new WeakMap(),
    _constants: {NUM_MAPS: 20, TLAS_STACK_SIZE: 8, BLAS_STACK_SIZE: 32, NUM_UNIFORM_LIGHTS: 64},
    _blasLayoutMask: 1, _shaderCapabilities: new WGPUShaderCapabilities(), _bevelSamples: 8, _hasDisplacement: false,
    _createPipelineLayout: () => ({}), _updateBindGroups: () => {pass._rayTraceBindGroups = [];},
    _meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0}))],
    _analyticLights: [], _emissiveTriangles: [], _targetOutputs: new Map(), _width: 16, _height: 16,
    _causticLight: {setDistribution() {}, use() {}, prepare: async () => pipeline()},
    _photonMap: {get: (target: object) => maps.get(target),
      ensure: (target: object) => { if (!maps.has(target)) maps.set(target, {data: {}}); return maps.get(target)!; },
      emission: {setDistribution() {}, use() {}, prepare: async () => pipeline()}}});
  return {pass, compile, completions, fail: () => { failNext = true; }};
}

interface Settings { pattern: number; photon: boolean; light: boolean }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** Applies one render's settings and takes the same decision as its trace call. */
function trace(pass: any, target: object, settings: Settings) {
  pass.useTarget(target);
  pass._constants.SAMPLING_PATTERN = settings.pattern;
  pass.setQuality({bounces: 3, bevel: false, dispersionWavelengths: 1, directLightCandidates: 4,
    caustics: {photonMapping: settings.photon, lightTracing: settings.light}});
  pass.updatePipeline();
  if (pass.getPipelineError()) return 'error';
  if (pass.isCompilingShader()) return 'waiting';
  return pass.isPipelineReady() ? 'sampling' : 'stuck';
}

describe('WebGPU pipeline liveness', () => {
  it('samples two renders with different caustics in the same frame', async () => {
    const {pass, completions} = fixture();
    const a = {}, b = {}, sa = {pattern: 0, photon: true, light: false}, sb = {pattern: 0, photon: false, light: false};
    const states = () => [trace(pass, a, sa), trace(pass, b, sb)];
    expect(states()).toEqual(['waiting', 'waiting']);
    completions.splice(0).forEach(done => done()); await flush();
    for (let frame = 0; frame < 4; frame++) expect(states()).toEqual(['sampling', 'sampling']);
  });

  it('uses a compiled variant while an obsolete compilation is still running', async () => {
    const {pass, completions} = fixture();
    const target = {}, compiled = {pattern: 0, photon: false, light: false};
    trace(pass, target, compiled);
    completions.splice(0).forEach(done => done()); await flush();
    expect(trace(pass, target, compiled)).toBe('sampling');
    expect(trace(pass, target, {...compiled, pattern: 5})).toBe('waiting');
    expect(trace(pass, target, compiled)).toBe('sampling');
  });

  it('confines a failed variant to the render that requested it', async () => {
    const {pass, completions, fail} = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = {}, b = {}, good = {pattern: 0, photon: false, light: false}, bad = {...good, pattern: 3};
    trace(pass, a, good);
    completions.splice(0).forEach(done => done()); await flush();
    fail(); expect(trace(pass, b, bad)).toBe('waiting');
    completions.splice(0).forEach(done => done()); await flush();
    expect(trace(pass, b, bad)).toBe('error');
    expect(trace(pass, a, good)).toBe('sampling');
    expect(trace(pass, b, bad)).toBe('error');
    vi.restoreAllMocks();
  });

  // Regressions here have been individual orderings of these events, so cover
  // the orderings instead of adding one more scenario.
  it.each(Array.from({length: 200}, (_, seed) => seed))('reaches sampling or an error after random events (seed %i)', async seed => {
    let state = seed * 2654435761 + 1 >>> 0;
    const random = (limit: number) => { state = state * 1664525 + 1013904223 >>> 0; return (state >>> 8) % limit; };
    const {pass, completions, fail} = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const targets = [{}, {}];
    const settings = (): Settings => ({pattern: random(3), photon: !random(2), light: !random(2)});
    const current = [settings(), settings()];
    for (let step = 0; step < 60; step++) {
      switch (random(7)) {
        case 0: case 1: { const which = random(2); expect(trace(pass, targets[which], current[which])).not.toBe('stuck'); break; }
        case 2: current[random(2)] = settings(); break;
        case 3: if (completions.length) completions.splice(random(completions.length), 1)[0](); await flush(); break;
        case 4: fail(); break;
        case 5: pass.useTarget(targets[random(2)]); break;
        case 6: pass._needsUpdateBindGroups = true; break;
      }
    }
    for (let frame = 0; frame < 3; frame++) {
      for (let which = 0; which < 2; which++) expect(trace(pass, targets[which], current[which])).not.toBe('stuck');
      completions.splice(0).forEach(done => done()); await flush();
    }
    for (let which = 0; which < 2; which++) {
      const final = trace(pass, targets[which], current[which]);
      expect(['sampling', 'error']).toContain(final);
    }
    vi.restoreAllMocks();
  });
});
