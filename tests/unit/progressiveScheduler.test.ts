import { describe, expect, it } from 'vitest';
import { loopImageState, updateProgressiveState, type ProgressiveState } from '../../src/renderer/progressiveScheduler';
import { traceSchema } from '../../src/settings/render';
import type Render from '../../src/Render';
import type Display from '../../src/Display';

describe('consecutive-edit heuristic', () => {
  it('leaves isolated edits immediate and holds consecutive edits until idle', () => {
    const policy = policyFixture();
    expect(policy.update(true, false, 0, 150)).toBe(false);
    expect(policy.update(false, false, 16, 150)).toBe(false);
    expect(policy.update(true, false, 32, 150)).toBe(false);
    expect(policy.update(true, false, 48, 150)).toBe(true);
    expect(policy.update(false, false, 197, 150)).toBe(true);
    expect(policy.update(false, false, 198, 150)).toBe(false);
  });
  it('lets an explicit interaction end without an idle tail', () => {
    const policy = policyFixture();
    policy.update(true, false, 0, 150); policy.update(true, false, 16, 150);
    expect(policy.update(true, true, 32, 150)).toBe(true);
    expect(policy.update(true, false, 48, 150)).toBe(false);
  });
  it('resets stale heuristic state', () => {
    let policy = policyFixture();
    policy.update(true, false, 0, 150); policy.update(true, false, 16, 150); policy = policyFixture();
    expect(policy.update(false, false, 32, 150)).toBe(false);
  });
});

describe('finished image state', () => {
  it('changes with every setting that changes the traced image', () => {
    const render = Object.fromEntries(Object.values(traceSchema).map(field => [field.key, field.default])) as Record<string, unknown>;
    const display = {canvas: {width: 1, height: 1}} as unknown as Display;
    const state = () => loopImageState(render as unknown as Render, display);
    const edits: Record<string, unknown> = {bounces: 6, clamping: 10, bevel: false, bevelSamples: 4, dispersionWavelengths: 1,
      caustics: {photonMapping: true}, directLightCandidates: 8, alphaBlendStrategy: 'deterministic-source-over',
      transmissiveOutputAlphaMin: 0, samplingPattern: 'random'};
    for (const field of Object.values(traceSchema).filter(field => field.kind === 'image')) {
      expect(edits).toHaveProperty(field.key);
      const before = state(), previous = render[field.key];
      render[field.key] = edits[field.key];
      expect(state(), field.key).not.toBe(before);
      render[field.key] = previous;
    }
  });
});

function policyFixture() {
  let state: ProgressiveState = {previousChanged: false, lastContinuousChange: -Infinity, changing: false};
  return {update(changed: boolean, active: boolean, now: number, idleMs: number) {
    const before = {...state};
    const next = updateProgressiveState(state, changed, active, now, idleMs);
    expect(state).toEqual(before); state = next; return state.changing;
  }};
}
