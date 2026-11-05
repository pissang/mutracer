import Engine from '../../src/Engine';
import {makeWebGLRenderTargets} from '../../src/renderer/WebGLRenderingPipeline';
import {expectDataOnlyDiagnostics} from '../helpers/diagnostics';
import {expect, it, vi} from 'vitest';
import {FragmentShader} from '../../src/renderer/shader';
import {Texture2D, constants, type WebGLDevice} from '../../src/renderer/webgl';
import {WebGLFullQuadPass} from '../../src/renderer/WebGLFullQuadPass';
import {textureRegion} from '../../src/renderer/textureRegion';
function context() {
  const values = new Map<PropertyKey, unknown>(); let constant = 100;
  const gl = new Proxy({}, {get(_target, key) {
    if (!values.has(key)) values.set(key, /^[A-Z_0-9]+$/.test(String(key)) ? (constants as unknown as Record<string, number>)[String(key)] ?? constant++
      : key === 'createTexture' || key === 'createFramebuffer' ? vi.fn(() => ({})) : key === 'getUniformLocation' ? vi.fn(() => null) : vi.fn());
    return values.get(key);
  }}) as WebGL2RenderingContext;
  const renderer = {gl, createProgram: () => ({}), isProgramCompiled: () => true, setViewport: vi.fn()} as unknown as WebGLDevice;
  return {gl, renderer};
}
it('reuses WebGL storage while changing the logical image region', () => {
  const {gl, renderer} = context(); const pass = new WebGLFullQuadPass('scratch', renderer, {shader: new FragmentShader({outputs: ['color'], main: 'void main(){out_color=vec4(1.0);}'})});
  pass.reserveCapacity(); pass.setSize(64, 32); pass.createPass({}); const texture = pass.getOutput('color');
  pass.setSize(32, 16); pass.createPass({}); expect(pass.getOutput('color')).toBe(texture);
  expect(textureRegion(texture)).toEqual({width: 32, height: 16}); expect(renderer.setViewport).toHaveBeenLastCalledWith(0, 0, 32, 16);
  pass.setSize(64, 32); pass.createPass({}); expect(gl.texImage2D).toHaveBeenCalledOnce(); pass.dispose();
});
it('reallocates storage when retained-image encoding changes at the same size', () => {
  const {gl} = context(); const texture = new Texture2D(); texture.ensureStorage(gl, 64, 32);
  texture.ensureStorage(gl, 64, 32, {type: constants.HALF_FLOAT});
  expect(gl.texImage2D).toHaveBeenCalledTimes(2); expect(texture.getMemoryBytes()).toBe(64 * 32 * 8);
  texture.dispose(gl); expect(texture.getMemoryBytes()).toBe(0);
});
it('releases unused resolve outputs and detaches their framebuffer attachments', () => {
  const {gl, renderer} = context(); const pass = new WebGLFullQuadPass('resolve', renderer, {shader: new FragmentShader({outputs: ['color', 'mask'], main: 'void main(){out_color=vec4(1.0);out_mask=vec4(0.0);}'})});
  pass.setSize(64, 32); pass.createPass({}); const mask = pass.getOutput('mask');
  pass.setOutputs(['color']); pass.createPass({}); expect(mask.getMemoryBytes()).toBe(0);
  expect(gl.framebufferTexture2D).toHaveBeenCalledWith(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + 1, gl.TEXTURE_2D, null, 0); pass.dispose();
});

it('keeps internal WebGL fixture methods out of Engine diagnostics', () => {
  vi.stubGlobal('Image', class {src = '';});
  const {renderer} = context();
  Object.assign(renderer, {getShaderCompilationDiagnostics: () => ({status: 'ready', modules: []})});
  const manager = makeWebGLRenderTargets(renderer);
  const target = manager.createTarget('diagnostics'); target.activate();
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
  Object.assign(engine, {_pipeline: manager, _info: {backend: 'webgl'}});
  try {
    expectDataOnlyDiagnostics(engine.getDiagnostics());
  } finally {engine.dispose(); vi.unstubAllGlobals();}
});
