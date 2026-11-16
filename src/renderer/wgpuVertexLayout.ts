/** Editing kernels read the existing compact attribute layout at dispatch time.
 * Packing and the specialized/native/WebGL readers keep their current layouts. */
const offsets = ['ATTR_STRIDE', 'NORMAL_OFF', 'UV_OFF', 'UV1_OFF', 'COLOR_OFF', 'TANGENT_OFF', 'MATERIALINDEX_OFF'];
const flags = ['HAS_VERTEX_UV', 'HAS_VERTEX_TANGENT', 'HAS_TRIANGLE_MATERIAL', 'COLOR_FLOAT', 'NORMAL_FLOAT', 'USE_VERTEX_COLOR'];
export const WGPU_RUNTIME_VERTEX_CONSTANTS = [...offsets, ...flags, 'USE_UV', 'USE_TANGENT'];

export function packWgpuVertexLayout(constants: Record<string, boolean | number>, output: Int32Array) {
  offsets.forEach((name, i) => {output[i] = Number(constants[name] ?? 0);});
  output[7] = flags.reduce((bits, name, i) => bits | (constants[name] ? 1 << i : 0), 0);
}

export function runtimeVertexLayoutSource(source: string) {
  const expressions: Record<string, string> = {};
  offsets.forEach((name, i) => {expressions[name] = /* wgsl */ `rtUniform.${i < 4 ? 'vertexLayout0' : 'vertexLayout1'}.${'xyzw'[i % 4]}`;});
  flags.forEach((name, i) => {expressions[name] = /* wgsl */ `((rtUniform.vertexLayout1.w & ${1 << i}) != 0)`;});
  expressions.USE_UV = expressions.HAS_VERTEX_UV;
  expressions.USE_TANGENT = expressions.HAS_VERTEX_TANGENT;
  return source.replace(new RegExp(`\\b(?:${WGPU_RUNTIME_VERTEX_CONSTANTS.join('|')})\\b`, 'g'), name => expressions[name]);
}
