import {SETTINGS as S, WORD_BYTES} from './layout.js';
import {normalizeBounces} from '../../src/renderer/pathLimits.js';
import {normalizeBevelSamples, normalizeDirectLightCandidates} from '../../src/renderer/renderingLimits.js';
import {traceSampling} from '../../src/renderer/sceneAssembly.js';

export function defaultSceneConfiguration() {
  return {bounces: 6, directLightCandidates: 2, bevelSamples: 8, clamping: 0, transmissiveAlphaMin: 1,
    causticFlags:0,lightPhotons:0,photonMapPhotons:0,photonMapRadius:0,sequenceOffset: 0, sampling: traceSampling('sobol', 64, 12345), variants: 15};
}
export function decodeSceneConfiguration(bytes: Uint8Array) {
  if (bytes.byteLength !== S.WORDS * WORD_BYTES) throw new Error('Invalid render settings size');
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, S.WORDS), f = new Float64Array(bytes.buffer, bytes.byteOffset, S.WORDS / 2);
  if (u[S.STRUCT_SIZE] !== S.WORDS * WORD_BYTES || u[S.SAMPLING_PATTERN] > 2) throw new Error('Invalid render settings');
  if (!Number.isFinite(f[S.CLAMPING / 2]) || !Number.isFinite(f[S.TRANSMISSIVE_ALPHA_MIN / 2]))
    throw new Error('Clamping and transmissive alpha settings must be finite');
  const radius=new Float32Array(bytes.buffer,bytes.byteOffset+S.PHOTON_MAP_RADIUS*4,1)[0];
  if((u[S.CAUSTIC_FLAGS]&~15)||((u[S.CAUSTIC_FLAGS]&8)&&!(u[S.CAUSTIC_FLAGS]&1))||!Number.isFinite(radius)||radius<0)throw new Error('Invalid caustic settings');
  const pattern = u[S.SAMPLING_PATTERN] === 0 ? 'sobol' : u[S.SAMPLING_PATTERN] === 1 ? 'zsobol' : 'random';
  return {bounces: normalizeBounces(f[S.BOUNCES / 2]), directLightCandidates: normalizeDirectLightCandidates(f[S.DIRECT_LIGHT_CANDIDATES / 2]),
    bevelSamples: normalizeBevelSamples(f[S.BEVEL_SAMPLES / 2]), clamping: f[S.CLAMPING / 2], transmissiveAlphaMin: f[S.TRANSMISSIVE_ALPHA_MIN / 2],
    causticFlags:u[S.CAUSTIC_FLAGS],lightPhotons:u[S.LIGHT_PHOTONS],photonMapPhotons:u[S.PHOTON_MAP_PHOTONS],photonMapRadius:new Float32Array(bytes.buffer,bytes.byteOffset+S.PHOTON_MAP_RADIUS*4,1)[0],sequenceOffset: u[S.SEQUENCE_OFFSET], sampling: traceSampling(pattern, u[S.MAX_SAMPLES], u[S.SEED]), variants: u[S.VARIANTS]};
}
