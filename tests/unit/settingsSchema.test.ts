import { describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import { renderSchema, traceSchema } from '../../src/settings/render';
import { displaySchema } from '../../src/settings/display';
import { bvhConfig, engineSchema, workerCount } from '../../src/settings/engine';
import { renderFixture } from '../helpers/renderPipeline';

const renderChanges: Record<string, unknown> = {
  aovs: ['depth'], aovSamples: 8,
  bounces: 5, clamping: 2, bevel: false, bevelSamples: 12, dispersionWavelengths: 1,
  caustics: {photonMapping: true, lightTracing: {photonsPerSample: 32}},
  directLightCandidates: 8, alphaBlendStrategy: 'deterministic-source-over', transmissiveOutputAlphaMin: .3,
  samplingPattern: 'random', timeBudgetMs: 50, maxTiles: 2, batchSamples: true,
};
const displayChanges: Record<string, unknown> = {
  aovDepthRange:[1,20],aovPositionScale:2,aovMotionScale:32,aovIdComponent:'material',
  toneMapping: 'linear', toneMappingExposure: 2, contrast: 2, saturation: .5, temperature: .2,
  tint: .1, vignette: .4, bloomIntensity: .5, bloomThreshold: 2, bloomRadius: .2,
  hdrOutputEnabled: true, channel: 'normal', shadowCatcherColor: [.2, .4, .6], shadowCatcherAlpha: .5,
};

describe('settings schemas', () => {
  it('covers enumerable settings and existing accessor settings with matching defaults', () => {
    const {engine} = renderFixture(); const render = new Render(engine);
    for (const [owner, schema, excluded] of [
      [render, renderSchema, []],
      [engine.display, Object.values(displaySchema), ['canvas','engine','settings']],
      [engine, engineSchema, ['scene','camera','display']],
    ] as const) {
      const keys = schema.map(field => field.key);
      const ownKeys = Object.keys(owner).filter(key => !key.startsWith('_') && !excluded.includes(key as never));
      for (const key of ownKeys) expect(keys).toContain(key);
      for (const field of schema) {
        expect(field.key in owner).toBe(true);
        expect((owner as unknown as Record<string, unknown>)[field.key]).toEqual(field.default);
      }
    }
    engine.dispose();
  });

  it('restarts when the nested photon radius changes in place',()=>{
    const {engine,targets}=renderFixture();
    const method={initialRadius: .1};
    const render=new Render(engine,{caustics:{photonMapping:method}});render.refine();
    method.initialRadius=.2;render.refine();
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(2);render.dispose();engine.dispose();
  });

  for (const field of Object.values(traceSchema).filter(field => field.kind !== 'sample-cap')) {
    it(`${field.key} ${field.kind === 'image' ? 'restarts' : 'preserves'} accumulation and reaches the target`, () => {
      const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
      Object.assign(render, {[field.key]: renderChanges[field.key]});
      render.refine();
      expect(render.status).not.toBe('error');
      expect(targets[0].restartSamples).toHaveBeenCalledTimes(field.kind === 'image' ? 2 : 1);
      expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({[field.key]: renderChanges[field.key]}));
      engine.dispose();
    });
  }
  it('restarts when nested caustic settings change in place', () => {
    const {engine, targets} = renderFixture();
    const render = new Render(engine, {caustics: {photonMapping: true, lightTracing: {photonsPerSample: 32}}});
    render.refine();
    render.caustics!.photonMapping = false; render.refine();
    (render.caustics!.lightTracing as {photonsPerSample: number}).photonsPerSample = 64;
    render.refine();
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(3);
    engine.dispose();
  });
  for (const samplingPattern of ['sobol', 'zsobol', 'random'] as const) {
    it(`sample cap invalidation follows ${samplingPattern}`, () => {
      const {engine, targets} = renderFixture(); const render = new Render(engine, {samplingPattern}); render.refine();
      render.maxSamples = 1024; render.refine();
      expect(targets[0].restartSamples).toHaveBeenCalledTimes(samplingPattern === 'zsobol' ? 2 : 1); engine.dispose();
    });
  }
  for (const field of Object.values(displaySchema)) {
    it(`${field.key} invalidates display filtering without restarting traces`, () => {
      const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
      engine.display.present(render); const invalidate = vi.spyOn(render, '_displayChanged');
      Object.assign(engine.display, {[field.key]: displayChanges[field.key]}); engine.display.present(render);
      if(field.group==='channel'||field.group==='aov')expect(invalidate).not.toHaveBeenCalled();else expect(invalidate).toHaveBeenCalledOnce(); expect(render.samples).toBe(1);
      expect(targets[0].restartSamples).toHaveBeenCalledOnce();
      const target = targets[0];
      if (field.group === 'toneMapping') expect(target.setToneMappingParams).toHaveBeenLastCalledWith(expect.objectContaining({[field.parameter]: displayChanges[field.key]}));
      else if (field.group === 'bloom') expect(target.setBloomParams).toHaveBeenLastCalledWith(expect.objectContaining({[field.parameter]: displayChanges[field.key]}));
      else if (field.group === 'hdr') expect(target.setHDROutputEnabled).toHaveBeenLastCalledWith(displayChanges[field.key]);
      else if (field.group === 'aov') expect(target.setAovDisplayOptions).toHaveBeenLastCalledWith(expect.objectContaining({[field.parameter]:displayChanges[field.key]}));
      else if (field.group === 'channel') expect(target.setOutput).toHaveBeenLastCalledWith(displayChanges[field.key]);
      else expect(target.setShadowCatcherParams).toHaveBeenLastCalledWith(engine.display.shadowCatcherColor, engine.display.shadowCatcherAlpha);
      engine.dispose();
    });
  }
  it('normalizes at submission while preserving ordinary property values and serialization', () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine);
    render.bevelSamples = 100; render.directLightCandidates = 100; render.refine();
    expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({bevelSamples: 32, directLightCandidates: 16}));
    expect({...render}).toMatchObject({bevelSamples: 100, directLightCandidates: 100});
    expect(Object.keys(render)).toContain('bounces'); engine.dispose();
  });
  it('uses engine descriptors for CPU build and resource settings without invalidating on worker count', () => {
    const {engine, pipeline} = renderFixture();
    engine.bvhBuilder = 'tinybvh'; engine.bvhLayout = 'bvh4'; engine.bvhSpatialSplits = true;
    expect(bvhConfig(engine)).toEqual({builder: 'tinybvh', layout: 'bvh4', spatialSplits: true});
    expect(engine.update()).toBe(true);
    engine.bvhWorkerCount = 2; expect(workerCount(engine)).toBe(2); expect(engine.update()).toBe(false);
    engine.textureAtlasBudgetBytes = 10000; expect(engine.update()).toBe(true);
    expect(pipeline.setTextureAtlasBudget).toHaveBeenLastCalledWith(10000); engine.dispose();
  });
});
