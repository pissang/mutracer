import {expect, it} from 'vitest';
import {decodeSceneConfiguration} from '../../native/src/scene-configuration.js';
import {SETTINGS as S, WORD_BYTES} from '../../native/src/layout.js';

function settings() {
  const bytes = new Uint8Array(S.WORDS * WORD_BYTES), u = new Uint32Array(bytes.buffer), f = new Float64Array(bytes.buffer);
  u[S.STRUCT_SIZE] = bytes.byteLength; u[S.SAMPLING_PATTERN] = 1; u[S.SEED] = 0xffffffff;
  u[S.MAX_SAMPLES] = 65; u[S.SEQUENCE_OFFSET] = 7; u[S.VARIANTS] = 2;
  f[S.BOUNCES / 2] = NaN; f[S.DIRECT_LIGHT_CANDIDATES / 2] = Infinity; f[S.BEVEL_SAMPLES / 2] = 7.7;
  f[S.CLAMPING / 2] = 3; f[S.TRANSMISSIVE_ALPHA_MIN / 2] = .5;
  return {bytes, u, f};
}
it('uses the same numeric normalization and ZSobol sequence rule as Web', () => {
  const {bytes} = settings(), result = decodeSceneConfiguration(bytes);
  expect(result).toMatchObject({bounces: 1, directLightCandidates: 4, bevelSamples: 8, clamping: 3,
    transmissiveAlphaMin: .5, sequenceOffset: 7, sampling: {code: 1, logSPP: 6, seed: 0xffffffff}});
});
it('rejects malformed or nonfinite radiometric settings before scene preparation', () => {
  const {bytes, u, f} = settings();
  expect(() => decodeSceneConfiguration(bytes.subarray(0, 60))).toThrow();
  u[S.SAMPLING_PATTERN] = 3; expect(() => decodeSceneConfiguration(bytes)).toThrow();
  u[S.SAMPLING_PATTERN] = 0; f[S.CLAMPING / 2] = NaN; expect(() => decodeSceneConfiguration(bytes)).toThrow();
});

it('accepts an explicit native texture budget and rejects invalid limits', () => {
  const {bytes, f} = settings();
  f[S.TEXTURE_BUDGET_BYTES / 2] = 2 * 1024 ** 3;
  expect(decodeSceneConfiguration(bytes).textureBudgetBytes).toBe(2 * 1024 ** 3);
  for (const value of [-1, NaN, Infinity, 2 ** 32]) {
    f[S.TEXTURE_BUDGET_BYTES / 2] = value;
    expect(() => decodeSceneConfiguration(bytes)).toThrow('texture budget');
  }
});
