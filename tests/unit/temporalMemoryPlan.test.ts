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
    expect(plan.historyRadius).toEqual({min: 1, max: 1});
    expect(plan.postRadius).toBe(1);
  });

  it('budgets retained custom AOV copies for the offline look-ahead', () => {
    const plain = normalizeTemporalOptions({denoiser: null});
    const custom = normalizeTemporalOptions({denoiser: {type: 'custom', denoiser: {async denoise() {}}, aovs: ['roughness', 'motion']}});
    expect(estimateTemporalMemory(32, 24, custom)).toBeGreaterThan(estimateTemporalMemory(32, 24, plain));
  });

  it('offers only the next eligible tier for a single OOM retry', () => {
    const options = normalizeTemporalOptions();
    const first = planTemporalMemory(32, 24, options, limits);
    const next = nextTemporalMemoryPlan(32, 24, options, first, limits);
    expect(next?.historyRadius).toEqual({min: 8, max: 8});
    expect(next?.postRadius).toBe(3);
  });
});
