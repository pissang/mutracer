import {describe, expect, it} from 'vitest';
import {hasTemporalFrameGap, isTemporalCameraCut} from '../../src/temporal/schedule';

describe('temporal frame continuity', () => {
  it('accepts the first and consecutive captured frames', () => {
    expect(hasTemporalFrameGap(undefined, 0)).toBe(false);
    expect(hasTemporalFrameGap(4, 5)).toBe(false);
  });

  it('treats a repeated or skipped render converge as a history boundary', () => {
    expect(hasTemporalFrameGap(4, 4)).toBe(true);
    expect(hasTemporalFrameGap(4, 6)).toBe(true);
  });
});

describe('temporal camera cut coverage', () => {
  it('cuts when fewer than ten percent of covered pixels accept the previous frame', () => {
    expect(isTemporalCameraCut(100, 9)).toBe(true);
    expect(isTemporalCameraCut(100, 10)).toBe(false);
    expect(isTemporalCameraCut(0, 0)).toBe(true);
  });
});
