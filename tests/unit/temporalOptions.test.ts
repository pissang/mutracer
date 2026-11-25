import {describe, expect, it} from 'vitest';
import {normalizeTemporalOptions} from '../../src/temporal/options.js';
import {historyNeighbors, readyThrough, temporalLatency} from '../../src/temporal/schedule.js';

describe('temporal denoiser options', () => {
  it('freezes the offline adopted defaults', () => {
    const options = normalizeTemporalOptions();
    expect(options).toEqual({mode: 'offline', historyRadius: {min: 8, max: 16}, postRadius: 3,
      stabilizeSparkle: true, denoiser: {type: 'oidn', model: 'cleanAuxLarge'}, accumulateGuides: false, historyInvalidation: 'auto', memoryBudget: undefined});
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.historyRadius)).toBe(true);
  });

  it('accepts a boolean guide-accumulation option', () => {
    expect(normalizeTemporalOptions({accumulateGuides: true}).accumulateGuides).toBe(true);
    expect(() => normalizeTemporalOptions({accumulateGuides: null as unknown as boolean})).toThrow(/boolean/);
  });

  it('uses the causal radius and rejects incompatible settings', () => {
    expect(normalizeTemporalOptions({mode: 'interactive'}).historyRadius).toEqual({min: 17, max: 17});
    expect(() => normalizeTemporalOptions({mode: 'interactive', historyRadius: {min: 1, max: 2}})).toThrow(/offline/);
    expect(() => normalizeTemporalOptions({postRadius: 0})).toThrow(/stabilizeSparkle/);
    expect(() => normalizeTemporalOptions({historyRadius: 33})).toThrow(RangeError);
  });
});

describe('temporal schedule', () => {
  const offline = {mode: 'offline' as const, historyRadius: {min: 8, max: 16}, postRadius: 3};
  it('accounts for both offline windows', () => {
    expect(temporalLatency(offline)).toBe(19);
    expect(readyThrough(19, offline)).toBe(-1);
    expect(readyThrough(20, offline)).toBe(0);
    expect(readyThrough(4, offline, true)).toBe(3);
  });
  it('truncates neighbors at shot ends', () => {
    expect(historyNeighbors(0, 3, offline, 2)).toEqual([1, 2]);
    expect(historyNeighbors(2, 3, offline, 2)).toEqual([1, 0]);
    expect(historyNeighbors(2, 5, offline, 2)).toEqual([1, 3, 0, 4]);
    expect(historyNeighbors(2, 5, {...offline, mode: 'interactive'}, 2)).toEqual([1, 0]);
  });
});
