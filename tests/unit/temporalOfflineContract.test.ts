import {expect, it} from 'vitest';
import fixture from '../fixtures/temporal-offline.json';
import {normalizeTemporalOptions, type TemporalDenoiserOptions} from '../../src/temporal/options';
import {readyThrough, temporalLatency} from '../../src/temporal/schedule';
import {planTemporalMemory} from '../../src/temporal/memoryPlan';

it('normalizes offline options shared with the native host', () => {
  for (const {input, expected} of fixture.options) {
    expect(normalizeTemporalOptions(input as TemporalDenoiserOptions)).toEqual(expected);
  }
  for (const input of fixture.invalid) expect(() => normalizeTemporalOptions(input as TemporalDenoiserOptions)).toThrow();
});

it('matches the offline readiness and flush boundaries', () => {
  for (const row of fixture.schedule) {
    const options = normalizeTemporalOptions(row.input);
    expect(temporalLatency(options)).toBe(row.latency);
    expect(readyThrough(row.pushed, options, row.flush)).toBe(row.ready);
  }
});

it('matches memory tiers and exact allocation sizes', () => {
  for (const row of fixture.memory) {
    const limits = {...fixture.limits, ...row.overrides};
    expect(planTemporalMemory(row.width, row.height, normalizeTemporalOptions(row.input), limits, row.materials))
      .toEqual({...row.expected, bytes: row.webBytes ?? row.expected.bytes});
  }
});
