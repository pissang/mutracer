import {afterEach, describe, expect, it, vi} from 'vitest';
import WGPURayTracePass, {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import {WGPUShaderCache} from '../../src/renderer/WGPUShaderCache';
import {WGPUShaderCapabilities} from '../../src/renderer/WGPUShaderCapabilities';
import {WGPU_SCENE_FEATURE_BITS} from '../../src/renderer/WGPUSceneFeatures';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createPlaneGeometry} from '../../src/util/commonGeometry';
import Mesh from '../../src/scene/Mesh';

const pipeline = () => ({getBindGroupLayout: () => ({})}) as unknown as GPUComputePipeline;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(shaderPrefetch: 'off' | 'editing') {
  const completions: (() => void)[] = [];
  const compile = vi.fn(() => new Promise<GPUComputePipeline>(resolve => completions.push(() => resolve(pipeline()))));
  const device = {createShaderModule: () => ({getCompilationInfo: async () => ({messages: []})}),
    createComputePipelineAsync: compile, pushErrorScope() {}, popErrorScope: async () => null} as unknown as GPUDevice;
  const pass = Object.create(WGPURayTracePass.prototype) as any;
  Object.assign(pass, {_device: device, _shaderCache: new WGPUShaderCache(device), _rtUniform: makeRayTraceUniform(), shaderPrefetch,
    _pendingGeometryUpdates: new Set(), _dirtyColorMeshes: new Set(), _traceVariants: new Map(), _queuedCompiles: [], _activeCompiles: 0, _traceModules: new Map(), _targetTransport: new WeakMap(),
    _constants: {NUM_MAPS: 20, TLAS_STACK_SIZE: 8, BLAS_STACK_SIZE: 32, NUM_UNIFORM_LIGHTS: 64, SAMPLING_PATTERN: 0},
    _blasLayoutMask: 1, _shaderCapabilities: new WGPUShaderCapabilities(), _bevelSamples: 8, _hasDisplacement: false,
    _createPipelineLayout: () => ({}), _updateBindGroups: () => {pass._rayTraceBindGroups = [];},
    _meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial())], _analyticLights: [], _emissiveTriangles: [], _targetOutputs: new Map(), _width: 16, _height: 16});
  const target = {};
  const trace = () => {
    pass.useTarget(target);
    pass.setQuality({bounces: 3, bevel: false, dispersionWavelengths: 1, directLightCandidates: 1, caustics: {photonMapping: false, lightTracing: false}});
    pass.updatePipeline();
    return pass.isCompilingShader() ? 'waiting' : pass.isPipelineReady() ? 'sampling' : 'stuck';
  };
  const complete = async () => { completions.splice(0).forEach(done => done()); await flush(); };
  return {pass, compile, trace, complete};
}

const thinFilm = WGPU_SCENE_FEATURE_BITS.HAS_THIN_FILM;

describe('editing shader prefetch', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('installs the prefetched variant for a lobe edit, then returns to the lean variant', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {pass, compile, trace, complete} = fixture('editing');
    expect(trace()).toBe('waiting');
    await complete();
    expect(trace()).toBe('sampling');
    // The editing variant compiles in the background while the lean one samples.
    expect(compile).toHaveBeenCalledTimes(2);
    await complete();
    // A thin-film edit renders at once through the editing variant.
    pass._constants.HAS_THIN_FILM = true;
    expect(trace()).toBe('sampling');
    expect(compile).toHaveBeenCalledTimes(2);
    expect(pass._activeVariant.capabilities.SCENE_CAPABILITIES & thinFilm).toBe(thinFilm);
    expect(JSON.parse(pass._activeVariant.structureKey).constants).toContainEqual(['HAS_MEDIUM', true]);
    // Once the scene has settled, the lean variant compiles and replaces it.
    now = 1000; trace();
    expect(compile).toHaveBeenCalledTimes(2);
    now = 3000; trace();
    expect(compile).toHaveBeenCalledTimes(3);
    await complete();
    trace(); trace();
    expect(JSON.parse(pass._activeVariant.structureKey).constants).not.toContainEqual(['HAS_MEDIUM', true]);
    expect(pass._activeVariant.capabilities.SCENE_CAPABILITIES & thinFilm).toBe(thinFilm);
  });

  it('compiles nothing extra when off', async () => {
    const {pass, compile, trace, complete} = fixture('off');
    trace(); await complete();
    expect(trace()).toBe('sampling');
    expect(compile).toHaveBeenCalledTimes(1);
    pass._constants.HAS_THIN_FILM = true;
    expect(trace()).toBe('waiting');
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
