import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {shaderSourceLoader, shaderIdentifierMap} from './shaderSourceLoader';
import {renameShaderIdentifiers} from '../../scripts/shader-identifiers.mjs';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';
import {WGPU_SCENE_FEATURE_BITS, wgpuSceneFeatureFlags} from '../../src/renderer/WGPUSceneFeatures';
import {original, stripped, rayTrace, compactRayTrace, tokens, gpu} from './shaderSourceFormattingFixture';

afterEach(() => { vi.unstubAllGlobals(); });

describe('shader generation independent of source formatting', () => {
  it('preserves specialized RGB, spectral and source-over shaders through the build transform', () => {
    gpu();
    for (const spectral of [false, true]) for (const hasAlpha of [false, true]) {
      for (const full of [false, true]) for (const dynamicEnvironment of [false, true]) {
        const options = {hasDisplacement: false, hasAlpha, hasSceneAlpha: hasAlpha,
          hasAnisotropyDirections: full, hasCoatNormals: full, blasLayoutMask: full ? 15 : 1,
          spectral, sceneCapabilities: full ? 0x7fffff : 0, materialCapabilities: full ? 3 : 0,
          lightCapabilities: full ? 31 : 1, dynamicEnvironment};
        const source = rayTrace(options), compact = compactRayTrace(options);
        expect(tokens(compact)).toEqual(tokens(source));
        expect(renameShaderIdentifiers(compact, shaderIdentifierMap)).toBe(compact);
        const parsed = makeShaderDataDefinitions(compact);
        expect(Object.keys(parsed.entryPoints).sort()).toEqual(['aovTrace', 'aovTraceCenter', 'depthQuery', 'main']);
        expect(parsed.uniforms.rtUniform.size).toBe(makeRayTraceUniform().buffer.byteLength);
      }
    }
  });

  it('keeps all runtime flags addressable in the same shader, including combinations', () => {
    gpu();
    const source = compactRayTrace({hasDisplacement: false, blasLayoutMask: 15});
    const sourceTokens = tokens(source)?.join(' ') ?? '';
    const names = Object.keys(WGPU_SCENE_FEATURE_BITS);
    const combinations = [0, 2 ** names.length - 1, ...names.map(name => WGPU_SCENE_FEATURE_BITS[name]),
      wgpuSceneFeatureFlags({HAS_THIN_FILM: true, HAS_COAT: true}),
      wgpuSceneFeatureFlags({HAS_FUZZ: true, HAS_SUBSURFACE: true, USE_DIFFUSE_MAPS: true})];
    for (const sceneFlags of combinations) for (let backgroundFlags = 0; backgroundFlags < 8; backgroundFlags++) {
      const {views} = makeRayTraceUniform();
      views.sceneFeatureFlags[0] = sceneFlags; views.backgroundFlags[0] = backgroundFlags;
      for (const bit of Object.values(WGPU_SCENE_FEATURE_BITS)) {
        expect(!!(views.sceneFeatureFlags[0] & bit)).toBe(!!(sceneFlags & bit));
      }
      for (const bit of [1, 2, 4]) expect(!!(views.backgroundFlags[0] & bit)).toBe(!!(backgroundFlags & bit));
    }
    // Feature/material specialization intentionally retains its existing form.
    for (const name of ['HAS_THIN_FILM', 'HAS_COAT', 'HAS_FUZZ', 'HAS_SUBSURFACE', 'USE_DIFFUSE_MAPS', 'USE_NORMAL_MAPS']) {
      const bit = WGPU_SCENE_FEATURE_BITS[name];
      expect(sourceTokens.includes(`rtUniform . sceneFeatureFlags & ${bit}u`), name).toBe(true);
    }
    for (const bit of [1, 2, 4]) expect(sourceTokens.includes(`rtUniform . backgroundFlags & ${bit}`)).toBe(true);

  });

  it('preserves the generated direction frames after formatting and identifier compression', () => {
    gpu();
    for (const hasDisplacement of [false, true]) for (const hasCoatNormals of [false, true]) {
      const options = {hasDisplacement, hasCoatNormals, hasAnisotropyDirections: true, hasAlpha: true, hasSceneAlpha: true, blasLayoutMask: 15};
      const source = rayTrace(options), compact = compactRayTrace(options);
      expect(tokens(compact)).toEqual(tokens(source));
      const definitions = makeShaderDataDefinitions(compact);
      const preparedName = shaderIdentifierMap.get('OpenPbrPreparedBsdf') ?? 'OpenPbrPreparedBsdf';
      const fieldName = shaderIdentifierMap.get('coatBasis') ?? 'coatBasis';
      expect(definitions.structs[preparedName].fields[fieldName]).toBeDefined();
    }
  });

  it.each([false, true])('generates and parses explicit WGSL sampling wrappers (scratch=%s)', scratch => {
    const device = gpu();
    const code = (loader: ReturnType<typeof shaderSourceLoader>) => {
      const {WGPUFullQuadPass} = loader('src/renderer/WGPUFullQuadPass.ts');
      const compose = loader('src/renderer/wgsl/compose.frag.wgsl.ts');
      const pass = new WGPUFullQuadPass('formatting', device, {
        inputs: ['colorTex', 'bloomTex', 'flatBackgroundMaskTex', 'foregroundTex', 'catcherBackgroundTex', 'shadowCatcherTex'],
        outputs: ['color', 'denoiseColor'], samplers: {linearSampler: {}},
        fsDefine: compose.composeDefine,
        fsMain: compose.composeMain + compose.compositeDenoiseOutputMain
      });
      if (scratch) pass.reserveCapacity();
      return pass._getFullFs();
    };
    const source = code(original), compact = code(stripped);
    expect(tokens(compact)).toEqual(tokens(source));
    const parsed = makeShaderDataDefinitions(compact);
    expect(Object.keys(parsed.entryPoints)).toEqual(['main']);
    expect('imageRegions' in parsed.uniforms).toBe(scratch);
    expect(compact).toContain('fn colorTexRegion()');
    expect(compact).toContain('fn load_colorTex(');
    expect(compact).toContain('fn sample_colorTex_linearSampler(');
  });

  it.each([false, true])('preserves and parses every bloom pass including sampled textures (scratch=%s)', scratch => {
    const device = gpu();
    function codes(loader: ReturnType<typeof shaderSourceLoader>) {
      const Bloom = loader('src/renderer/WGPUBloomPass.ts').default;
      const bloom = new Bloom(device);
      if (scratch) bloom.reserveCapacity();
      return [bloom._brightPass, ...bloom._downsamplePasses, ...bloom._blurHPasses, ...bloom._blurVPasses, ...bloom._blendPasses]
        .map(pass => pass._getFullFs() as string);
    }
    const source = codes(original), compact = codes(stripped);
    for (let i = 0; i < source.length; i++) {
      expect(tokens(compact[i])).toEqual(tokens(source[i]));
      expect(Object.keys(makeShaderDataDefinitions(compact[i]).entryPoints)).toEqual(['main']);
    }
    expect(compact[1].includes('sample_colorTex_linearSampler(uv2')).toBe(true);
  });

  it.each([false, true])('preserves explicit GLSL sampling and region selection (scratch=%s)', scratch => {
    function code(loader: ReturnType<typeof shaderSourceLoader>) {
      const {WebGLFullQuadPass} = loader('src/renderer/WebGLFullQuadPass.ts');
      const {brightFragment} = loader('src/renderer/glsl/webglPipeline.frag.ts');
      const pass = new WebGLFullQuadPass('formatting', {}, {shader: brightFragment});
      if (scratch) pass.reserveCapacity();
      const shader = pass._bindings.shader;
      return {source: shader.functions.map((fn: () => string) => fn()).join('\n') + shader.main, uniforms: shader.uniforms};
    }
    const source = code(original), compact = code(stripped);
    expect(tokens(compact.source)).toEqual(tokens(source.source));
    expect('colorTexRegionSize' in compact.uniforms).toBe(scratch);
    expect(compact.source).toContain('ivec2 colorTexRegion()');
    expect(compact.source).toContain('sample_colorTex(');
  });
});

describe('display upscale shaders independent of source formatting', () => {
  it('generates the same EASU detail, guide and display AOV shaders from build-formatted sources', () => {
    gpu();
    const load = (loader: typeof original) => loader('src/renderer/wgsl/easuDetail.wgsl.ts');
    const source = load(original), compact = load(stripped);
    for (const separate of [false, true]) for (const silhouettes of [false, true]) for (const guided of [false, true]) {
      expect(tokens(compact.easuDetailShader(separate, silhouettes, guided))).toEqual(tokens(source.easuDetailShader(separate, silhouettes, guided)));
    }
    for (const depth of [false, true]) expect(tokens(compact.albedoDownsampleShader(depth))).toEqual(tokens(source.albedoDownsampleShader(depth)));
    expect(tokens(compact.guidedCoefficientShader)).toEqual(tokens(source.guidedCoefficientShader));
    expect(tokens(compact.toneLutShader)).toEqual(tokens(source.toneLutShader));
    // The detail variants must differ from plain EASU in both builds.
    const easu = original('src/renderer/wgsl/easu.wgsl.ts').easuShader, compactEasu = stripped('src/renderer/wgsl/easu.wgsl.ts').easuShader;
    expect(tokens(compact.easuDetailShader())).not.toEqual(tokens(compactEasu));
    expect(tokens(source.easuDetailShader())).not.toEqual(tokens(easu));
    const read = (loader: typeof original) => {
      const {compactAovReadShader} = loader('src/renderer/wgsl/aovCompact.wgsl.ts');
      const common = loader('src/renderer/wgsl/aovResolve.wgsl.ts').aovResolveCommon;
      const display = loader('src/renderer/wgsl/aovDisplay.wgsl.ts').aovDisplayShader('rgba16float');
      return [compactAovReadShader(common, '@group(0) @binding(0) var<storage,read> accumulation: array<AovResolvedAccumulation>;', 'AovResolvedAccumulation'),
        compactAovReadShader(display, '@group(0) @binding(0) var<storage, read> accumulation: array<DisplayAovAccum>;', 'DisplayAovAccum')];
    };
    const [readSource, readCompact] = [read(original), read(stripped)];
    readSource.forEach((code, index) => {
      expect(code).toContain('loadAov(');
      expect(tokens(readCompact[index])).toEqual(tokens(code));
    });
    const options = {hasDisplacement: false, blasLayoutMask: 1, displayAovStorage: true};
    expect(tokens(compactRayTrace(options))).toEqual(tokens(rayTrace(options)));
  });
});
