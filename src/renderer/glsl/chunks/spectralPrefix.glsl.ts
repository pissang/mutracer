// The three wavelength continuations run inside one fragment invocation.
export const spectralPrefixGlsl = /* glsl */ `
struct SpectralCompleted {
  bool ready; vec4 result; RayTraceAuxiliary aux;
  uvec4 rng; uint counter; uint bounce;
};
SpectralCompleted spCompleted[2];
bool spActive = true;
int spChannel;
int spCall = 0;
int spForkCall = -1;
struct SpectralPrimary {
  SurfaceInteraction si; OpenPbrResolvedMaterial mat; RayTraceAuxiliary aux;
  uvec4 rng; uint counter; uint bounce;
};
SpectralPrimary spPrimary;
bool spDisperses(OpenPbrResolvedMaterial mat) {
  return mat.transmissionDispersionScale > 0.0 && mat.specularIor != 1.0;
}
void spFork(inout Path path) {
  spActive = false; pathChannel = spChannel;
  path.li = sampling_spectral_rgb_filter(path.li, spChannel);
}
vec4 spReplay(int slot, inout RayTraceAuxiliary aux) {
  SpectralCompleted saved = spCompleted[slot];
  aux = saved.aux; s0 = saved.rng; hashedCounter = saved.counter; samplingBounce = saved.bounce;
  return vec4(sampling_spectral_rgb_filter(saved.result.rgb, spChannel), saved.result.a);
}
vec4 spFinish(int slot, vec4 result, RayTraceAuxiliary aux) {
  if (!spActive) return result;
  if (spChannel == 1) spCompleted[slot] = SpectralCompleted(true, result, aux, s0, hashedCounter, samplingBounce);
  return vec4(sampling_spectral_rgb_filter(result.rgb, spChannel), result.a);
}
`;
export type PrefixBindings = Record<string, [type: string, expression: string]>;
export const prefixRandomBindings: PrefixBindings = {
  rng: ['uvec4', 's0'], counter: ['uint', 'hashedCounter'], bounce: ['uint', 'samplingBounce']
};
export function prefixCheckpoint(name: string, bindings: PrefixBindings) {
  return `struct ${name}State {\n${Object.entries(bindings).map(([key, [type]]) => `  ${type} ${key};`).join('\n')}\n};\n${name}State ${name};\n`;
}
export function prefixSave(name: string, bindings: PrefixBindings) {
  return Object.entries(bindings).map(([key, [, value]]) => `${name}.${key} = ${value};`).join('\n');
}
export function prefixRestore(name: string, bindings: PrefixBindings) {
  return Object.entries(bindings).map(([key, [, value]]) => `${value} = ${name}.${key};`).join('\n');
}
