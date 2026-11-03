// Browser-only checkpoint source. Native and nonspectral generation omit it.
// Structured-sample caches are pure dimension lookups; only PCG, hashed draws
// and the two current-bounce indices need restoring.
export function spectralPrefixWgsl(shareSecondary = true) { return /* wgsl */ `
struct SpectralCompleted {
  ready: bool,
  result: vec4f,
  aux: RayTraceAuxiliary,
  rng: vec4u,
  counter: u32,
  bounce: u32,
  vertex: u32,
}
var<private> spCompleted: array<SpectralCompleted, 2>;
var<private> spActive: bool;
var<private> spEnabled: bool;
var<private> spChannel: i32;
var<private> spWavelength: f32;
var<private> spCall: i32;
var<private> spForkCall: i32 = -1;

fn spBegin(channel: i32, wavelength: f32, primaryFork: bool) {
  spEnabled = SPECTRAL && rtUniform.dispersionWavelengths != 1${shareSecondary ? '' : ' && false'};
  spChannel = channel; spWavelength = wavelength;
  spActive = spEnabled && !primaryFork;
  spCall = 0;
}
fn spDisperses(ma: OpenPbrResolvedMaterial) -> bool {
  return ma.transmissionDispersionScale > 0.0 && ma.specularIor != 1.0;
}
fn spFork(path: ptr<function, Path>, si: ptr<function, SurfaceInteraction>) {
  spActive = false;
  (*path).li = sampling_spectral_rgb_filter((*path).li, spChannel);
  (*si).spectralChannel = spChannel; (*si).wavelength = spWavelength;
}
fn spReplay(slot: i32, aux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  let saved = spCompleted[slot];
  *aux = saved.aux;
  s0 = saved.rng; hashedCounter = saved.counter;
  samplingBounce = saved.bounce; bounceIndex = saved.vertex;
  return vec4f(sampling_spectral_rgb_filter(saved.result.rgb, spChannel), saved.result.a);
}
fn spFinish(slot: i32, result: vec4f, aux: RayTraceAuxiliary) -> vec4f {
  if (!spActive) { return result; }
  if (spChannel == 1) {
    spCompleted[slot] = SpectralCompleted(true, result, aux, s0, hashedCounter, samplingBounce, bounceIndex);
  }
  return vec4f(sampling_spectral_rgb_filter(result.rgb, spChannel), result.a);
}
`; }

export type PrefixBindings = Record<string, [type: string, expression: string]>;
export const prefixRandomBindings: PrefixBindings = {
  rng: ['vec4u', 's0'], counter: ['u32', 'hashedCounter'],
  bounce: ['u32', 'samplingBounce'], vertex: ['u32', 'bounceIndex']
};
export function prefixCheckpoint(name: string, bindings: PrefixBindings) {
  return `struct ${name}State {\n${Object.entries(bindings).map(([key, [type]]) => `  ${key}: ${type},`).join('\n')}\n}\nvar<private> ${name}: ${name}State;\n`;
}
export function prefixSave(name: string, bindings: PrefixBindings) {
  return Object.entries(bindings).map(([key, [, value]]) => `${name}.${key} = ${value};`).join('\n');
}
export function prefixRestore(name: string, bindings: PrefixBindings) {
  return Object.entries(bindings).map(([key, [, value]]) => `${value} = ${name}.${key};`).join('\n');
}
