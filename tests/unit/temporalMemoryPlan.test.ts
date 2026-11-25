import {describe, expect, it} from 'vitest';
import {normalizeTemporalOptions} from '../../src/temporal/options';
import {estimateTemporalMemory, nextTemporalMemoryPlan, planTemporalMemory, temporalMemoryTiers} from '../../src/temporal/memoryPlan';

const limits = {maxTextureDimension2D: 16384, maxTextureArrayLayers: 2048,
  maxBufferSize: 2 ** 40, maxStorageBufferBindingSize: 2 ** 40};

describe('temporal memory planner', () => {
  it('uses the full requested plan when no budget forces degradation', () => {
    const options = normalizeTemporalOptions();
    const plan = planTemporalMemory(32, 24, options, limits);
    expect(plan.historyRadius).toEqual({min: 8, max: 16});
    expect(plan.postRadius).toBe(3);
    expect(plan.bytes).toBe(estimateTemporalMemory(32, 24, options));
  });

  it('degrades history before post, then reaches the minimum history-one post-zero plan', () => {
    const options = normalizeTemporalOptions();
    expect(temporalMemoryTiers(options)).toEqual([
      {historyRadius: {min: 8, max: 16}, postRadius: 3},
      {historyRadius: {min: 8, max: 8}, postRadius: 3},
      {historyRadius: {min: 4, max: 4}, postRadius: 3},
      {historyRadius: {min: 2, max: 2}, postRadius: 3},
      {historyRadius: {min: 2, max: 2}, postRadius: 2},
      {historyRadius: {min: 2, max: 2}, postRadius: 1},
      {historyRadius: {min: 1, max: 1}, postRadius: 0},
    ]);
  });

  it('preserves zero requested history when post processing is degraded away', () => {
    const options = normalizeTemporalOptions({historyRadius: 0, postRadius: 3});
    expect(temporalMemoryTiers(options)).toEqual([
      {historyRadius: {min: 0, max: 0}, postRadius: 3},
      {historyRadius: {min: 0, max: 0}, postRadius: 2},
      {historyRadius: {min: 0, max: 0}, postRadius: 1},
      {historyRadius: {min: 0, max: 0}, postRadius: 0},
    ]);
  });

  it('chooses the first quality tier within the budget', () => {
    const base = normalizeTemporalOptions();
    const tiers = temporalMemoryTiers(base);
    const next = normalizeTemporalOptions({memoryBudget: estimateTemporalMemory(32, 24, {...base, ...tiers[2]})});
    const plan = planTemporalMemory(32, 24, next, limits);
    expect(plan.historyRadius).toEqual({min: 4, max: 4});
    expect(plan.postRadius).toBe(3);
  });

  it('rejects a budget below the smallest supported plan', () => {
    const base = normalizeTemporalOptions();
    const tiers = temporalMemoryTiers(base);
    const smallest = estimateTemporalMemory(32, 24, {...base, ...tiers.at(-1)!});
    const options = normalizeTemporalOptions({memoryBudget: smallest - 1});
    expect(() => planTemporalMemory(32, 24, options, limits)).toThrow(/minimum plan/);
  });

  it('degrades until all texture-array layers fit device limits', () => {
    const options = normalizeTemporalOptions({mode: 'interactive', historyRadius: 8, postRadius: 1});
    const plan = planTemporalMemory(32, 24, options, {...limits, maxTextureArrayLayers: 9});
    expect(plan.historyRadius).toEqual({min: 2, max: 2});
    expect(plan.postRadius).toBe(1);
  });

  it('budgets the full offline OIDN guide ring and two window scratch images', () => {
    const base = normalizeTemporalOptions();
    const windowed = normalizeTemporalOptions({accumulateGuides: true});
    const w = 1280, h = 720;
    const budget = estimateTemporalMemory(w, h, base);
    expect(estimateTemporalMemory(w, h, windowed) - budget).toBe(w * h * (16 * 16 + 32));
    expect(planTemporalMemory(w, h, {...windowed, memoryBudget: budget}, limits).historyRadius.max).toBe(8);
    for (const override of [{historyRadius: 0}, {denoiser: null}] as const) {
      const options = normalizeTemporalOptions({...override, accumulateGuides: true});
      expect(estimateTemporalMemory(w, h, options)).toBe(estimateTemporalMemory(w, h, {...options, accumulateGuides: false}));
    }
  });

  it('keeps the interactive plan independent of guide accumulation', () => {
    const enabled = normalizeTemporalOptions({mode: 'interactive', accumulateGuides: true});
    const disabled = normalizeTemporalOptions({mode: 'interactive'});
    expect(planTemporalMemory(1280, 720, enabled, limits)).toEqual(planTemporalMemory(1280, 720, disabled, limits));
  });

  it('budgets retained custom AOV copies for the offline look-ahead', () => {
    const plain = normalizeTemporalOptions({denoiser: null});
    const custom = normalizeTemporalOptions({denoiser: {type: 'custom', denoiser: {async denoise() {}}, aovs: ['roughness', 'motion']}});
    expect(estimateTemporalMemory(32, 24, custom)).toBeGreaterThan(estimateTemporalMemory(32, 24, plain));
  });

  it('budgets the per-material revision table and post change lists', () => {
    const options = normalizeTemporalOptions({historyRadius: 1, postRadius: 1, mode: 'interactive'});
    const base = estimateTemporalMemory(32, 24, options);
    const withMaterials = estimateTemporalMemory(32, 24, options, 3);
    const postSlots = options.postRadius + 1;
    expect(withMaterials - base).toBe(3 * 8 - 8 + postSlots * ((3 + 1) * 4 - 8));
    const withoutPost = normalizeTemporalOptions({historyRadius: 1, postRadius: 0, mode: 'interactive', stabilizeSparkle: false});
    expect(estimateTemporalMemory(32, 24, withoutPost, 3) - estimateTemporalMemory(32, 24, withoutPost)).toBe(3 * 8 - 8);
  });

  it('offers only the next eligible tier for a single OOM retry', () => {
    const options = normalizeTemporalOptions();
    const first = planTemporalMemory(32, 24, options, limits);
    const next = nextTemporalMemoryPlan(32, 24, options, first, limits);
    expect(next?.historyRadius).toEqual({min: 8, max: 8});
    expect(next?.postRadius).toBe(3);
  });

  it('accounts for reflection motion history, capture and scratch only offline', () => {
    const plain = normalizeTemporalOptions();
    const enabled = normalizeTemporalOptions({reflectionMotion: true});
    expect(estimateTemporalMemory(1280, 720, enabled) - estimateTemporalMemory(1280, 720, plain))
      .toBe(788_889_600);
    const interactive = normalizeTemporalOptions({mode: 'interactive', reflectionMotion: true});
    expect(estimateTemporalMemory(1280, 720, interactive)).toBe(
      estimateTemporalMemory(1280, 720, {...interactive, reflectionMotion: false}));
  });
});
