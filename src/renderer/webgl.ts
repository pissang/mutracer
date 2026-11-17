import type { ShaderCompilationDiagnostics } from './RenderingPipeline.js';
import { FragmentShader, type ShaderDefineValue, type ShaderUniform } from './shader.js';

export { FragmentShader, Shader, createShaderMixin, glsl } from './shader.js';

import {Texture2D} from './textureData.js';
export {constants, Texture2D, Texture2DArray} from './textureData.js';
export type {TextureImageSource, TexturePixelSource, TextureOptions} from './textureData.js';

export class WebGLProgramBindings {
  readonly shader: FragmentShader;
  readonly uniforms: Record<string, ShaderUniform>;
  readonly defines: Record<string, ShaderDefineValue>;
  private _programs = new Map<string, WebGLProgram>();

  constructor(shader: FragmentShader) {
    this.shader = shader;
    this.uniforms = Object.fromEntries(
      Object.entries(shader.uniforms).map(([name, uniform]) => [
        name,
        { ...uniform, value: cloneValue(uniform.value) }
      ])
    );
    this.defines = { ...shader.defines };
  }

  set(name: string, value: unknown) {
    if (value === undefined || !this.uniforms[name]) return false;
    const changed = this.uniforms[name].value !== value;
    this.uniforms[name].value = value;
    return changed;
  }

  setUniforms(values: Record<string, unknown>) {
    Object.entries(values).forEach(([name, value]) => this.set(name, value));
  }

  get(name: string): any {
    return this.uniforms[name]?.value;
  }

  setDefine(name: string, value: ShaderDefineValue) {
    this.defines[name] = value;
  }

  deleteDefine(name: string) {
    delete this.defines[name];
  }

  getProgram(renderer: WebGLDevice) {
    const textureDefines: Record<string, null> = {};
    for (const [name, uniform] of Object.entries(this.uniforms)) {
      if (isSampler(uniform.type) && uniform.value) {
        textureDefines[`${name.toUpperCase()}_ENABLED`] = null;
      }
    }
    const defines = { ...this.defines, ...textureDefines };
    const key = JSON.stringify(defines);
    let program = this._programs.get(key);
    if (!program) {
      program = renderer.createProgram(this.shader, defines);
      this._programs.set(key, program);
    }
    return program;
  }

  bind(renderer: WebGLDevice) {
    const gl = renderer.gl;
    const program = this.getProgram(renderer);
    if (!renderer.isProgramCompiled(program)) return false;
    gl.useProgram(program);
    let textureUnit = 0;
    for (const [name, uniform] of Object.entries(this.uniforms)) {
      const location = gl.getUniformLocation(program, name);
      if (location === null) continue;
      const value = uniform.value;
      if (isSampler(uniform.type)) {
        const texture = value as Texture2D | undefined;
        (texture || renderer.emptyTexture).bind(gl, textureUnit);
        gl.uniform1i(location, textureUnit++);
      } else {
        setUniform(gl, location, uniform, value);
      }
    }
    return true;
  }
}

function cloneValue(value: unknown): any {
  return Array.isArray(value) ? value.slice() : value;
}

function isSampler(type: string) {
  return type.includes('sampler');
}

function flatten(value: any): number[] | Float32Array {
  if (!value) return [];
  if (ArrayBuffer.isView(value)) return value as Float32Array;
  return Array.isArray(value) ? value.flat(Infinity) : [value];
}

function setUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  uniform: ShaderUniform,
  value: any
) {
  if (value === undefined || value === null) return;
  const data = flatten(value);
  if (uniform.array) {
    if (uniform.type === 'int') gl.uniform1iv(location, data as number[]);
    else if (uniform.type === 'vec2') gl.uniform2fv(location, data as number[]);
    else if (uniform.type === 'vec3') gl.uniform3fv(location, data as number[]);
    else if (uniform.type === 'vec4') gl.uniform4fv(location, data as number[]);
    else if (uniform.type === 'mat3') gl.uniformMatrix3fv(location, false, data as number[]);
    else if (uniform.type === 'mat4') gl.uniformMatrix4fv(location, false, data as number[]);
    else gl.uniform1fv(location, data as number[]);
    return;
  }
  switch (uniform.type) {
    case 'bool':
    case 'int':
      gl.uniform1i(location, Number(value));
      break;
    case 'float':
      gl.uniform1f(location, Number(value));
      break;
    case 'vec2':
      gl.uniform2fv(location, data as number[]);
      break;
    case 'vec3':
      gl.uniform3fv(location, data as number[]);
      break;
    case 'vec4':
      gl.uniform4fv(location, data as number[]);
      break;
    case 'ivec2':
      gl.uniform2iv(location, data as number[]);
      break;
    case 'ivec3':
      gl.uniform3iv(location, data as number[]);
      break;
    case 'ivec4':
      gl.uniform4iv(location, data as number[]);
      break;
    case 'mat3':
      gl.uniformMatrix3fv(location, false, data as number[]);
      break;
    case 'mat4':
      gl.uniformMatrix4fv(location, false, data as number[]);
      break;
  }
}

const fullscreenVertex = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_Texcoord;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_Texcoord = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function composeFragment(
  shader: FragmentShader,
  defines: Record<string, ShaderDefineValue>
) {
  const defineCode = Object.entries(defines)
    .filter(([, value]) => value !== false && value !== undefined)
    .map(([name, value]) =>
      value === null || value === true ? `#define ${name}` : `#define ${name} ${value}`
    )
    .join('\n');
  const uniformCode = Object.entries(shader.uniforms)
    .map(([name, uniform]) => {
      const guarded = uniform.array && isNaN(Number(uniform.len));
      const declaration = `uniform ${uniform.type} ${name}${
        uniform.array ? `[${uniform.len}]` : ''
      };`;
      return guarded
        ? `#ifdef ${uniform.len}\n${declaration}\n#endif`
        : declaration;
    })
    .join('\n');
  const outputCode = shader.outputs
    .map((name, index) => `layout(location=${index}) out highp ${shader.outputTypes[name] ?? 'vec4'} out_${name};`)
    .join('\n');
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
${defineCode}
${outputCode}
${uniformCode}
in vec2 v_Texcoord;
${shader.functions.map((fn) => fn()).join('\n')}
${shader.main}`;
}

export interface RendererOptions extends WebGLContextAttributes {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  pixelRatio?: number;
  parallelShaderCompile?: boolean;
}

export class WebGLDevice {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly emptyTexture = new Texture2D();
  private _viewport: [number, number, number, number] = [0, 0, 1, 1];
  private _viewportStack: Array<[number, number, number, number]> = [];
  private _programs = new Set<WebGLProgram>();
  private _parallel?: KHR_parallel_shader_compile;
  private _pendingPrograms = new Map<WebGLProgram, {shader: FragmentShader; shaders: WebGLShader[]}>();
  private _programErrors = new Map<WebGLProgram, Error>();
  private _compilationStart = 0;
  private _compilationRecords: {
    program: WebGLProgram; label: string; bytes: number; lines: number; fingerprint: string;
    startedAt: number; completedAt?: number; generationMs: number; creationMs: number;
  }[] = [];

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    const gl = options.canvas.getContext('webgl2', options) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2.0 is required');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this._parallel = options.parallelShaderCompile
      ? gl.getExtension('KHR_parallel_shader_compile') || undefined
      : undefined;
    this.resize(this.canvas.width, this.canvas.height);
  }

  createProgram(
    shader: FragmentShader,
    defines: Record<string, ShaderDefineValue>
  ) {
    const gl = this.gl;
    const startedAt = performance.now();
    if (!this._compilationRecords.length) this._compilationStart = startedAt;
    const fragment = composeFragment(shader, defines);
    const generationMs = performance.now() - startedAt;
    const source = fullscreenVertex + fragment;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    const creationStart = performance.now();
    const program = gl.createProgram()!;
    const asynchronous = !!this._parallel && shader.parallelCompile;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const result = gl.createShader(type)!;
      shaders.push(result);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      // COMPILE_STATUS and LINK_STATUS can synchronously wait for the driver.
      // Poll COMPLETION_STATUS_KHR before either query for large programs.
      if (!asynchronous && !gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(result);
        gl.deleteShader(result);
        throw new Error(`${shader.name || 'WebGL shader'}: ${message}\n${source}`);
      }
      gl.attachShader(program, result);
      if (!asynchronous) gl.deleteShader(result);
    };
    compile(gl.VERTEX_SHADER, fullscreenVertex);
    compile(gl.FRAGMENT_SHADER, fragment);
    gl.linkProgram(program);
    if (asynchronous) this._pendingPrograms.set(program, {shader, shaders});
    else if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `${shader.name || 'WebGL program'}: ${gl.getProgramInfoLog(program)}`
      );
    }
    this._programs.add(program);
    this._compilationRecords.push({program, label: shader.name || 'WebGL program',
      bytes: new TextEncoder().encode(source).byteLength, lines: source.split('\n').length,
      fingerprint: (hash >>> 0).toString(16).padStart(8, '0'), startedAt,
      generationMs, creationMs: performance.now() - creationStart,
      completedAt: asynchronous ? undefined : performance.now()});
    return program;
  }

  isProgramCompiled(program: WebGLProgram) {
    const error = this._programErrors.get(program);
    if (error) throw error;
    const pending = this._pendingPrograms.get(program);
    if (!pending) return true;
    const gl = this.gl;
    if (!gl.getProgramParameter(program, this._parallel!.COMPLETION_STATUS_KHR)) return false;
    this._pendingPrograms.delete(program);
    try {
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const details = pending.shaders.filter(s => !gl.getShaderParameter(s, gl.COMPILE_STATUS))
          .map(s => `${gl.getShaderInfoLog(s)}\n${gl.getShaderSource(s)}`).join('\n');
        const failure = new Error(`${pending.shader.name || 'WebGL program'}: ${gl.getProgramInfoLog(program)}${details ? '\n' + details : ''}`);
        this._programErrors.set(program, failure);
        throw failure;
      }
    } finally {
      pending.shaders.forEach(shader => gl.deleteShader(shader));
    }
    const record = this._compilationRecords.find(record => record.program === program);
    if (record) record.completedAt = performance.now();
    return true;
  }

  /** Cumulative program compilation measurements used by preparation progress. */
  getShaderCompilationDiagnostics(): ShaderCompilationDiagnostics {
    const now = performance.now(), records = this._compilationRecords;
    for (const record of records) {
      if (record.completedAt === undefined && this.isProgramCompiled(record.program)) record.completedAt = now;
    }
    const completed = records.filter(record => record.completedAt !== undefined);
    const duration = completed.length === records.length && records.length > 0
      ? Math.max(...completed.map(record => record.completedAt!)) - this._compilationStart : undefined;
    const concurrency = records.flatMap(record => [
      {time: record.startedAt, change: 1},
      ...(record.completedAt === undefined ? [] : [{time: record.completedAt, change: -1}])
    ]).sort((a,b) => a.time - b.time || a.change - b.change);
    let active = 0, peak = 0;
    for (const event of concurrency) { active += event.change; peak = Math.max(peak, active); }
    return {
      status: completed.length === records.length ? 'ready' : 'compiling',
      sourceBytes: records.reduce((sum, record) => sum + record.bytes, 0),
      sourceLines: records.reduce((sum, record) => sum + record.lines, 0),
      pipelineCount: records.length, completedPipelineCount: completed.length,
      sourceGenerationTimeMs: records.reduce((sum, record) => sum + record.generationMs, 0),
      moduleCreationTimeMs: records.reduce((sum, record) => sum + record.creationMs, 0),
      modules: records.map(record => ({label: record.label, sourceBytes: record.bytes, sourceLines: record.lines, sourceFingerprint: record.fingerprint})),
      pipelines: records.map(record => ({label: record.label, entryPoint: 'main', firstFrameRequired: true,
        status: record.completedAt === undefined ? 'compiling' : 'ready',
        startedAtMs: record.startedAt - this._compilationStart,
        endedAtMs: record.completedAt === undefined ? undefined : record.completedAt - this._compilationStart,
        durationMs: record.completedAt === undefined ? undefined : record.completedAt - record.startedAt})),
      maximumConcurrentPipelineCount: this._parallel ? records.length : Math.min(records.length, 1),
      peakConcurrentPipelineCount: peak,
      pipelineCompilationTimeMs: duration, totalTimeMs: duration
    };
  }

  isAllProgramCompiled() {
    for (const program of this._programs) {
      if (!this.isProgramCompiled(program)) {
        return false;
      }
    }
    return true;
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.setViewport(0, 0, width, height);
  }

  getWidth() {
    return this.canvas.width;
  }
  getHeight() {
    return this.canvas.height;
  }
  saveViewport() {
    this._viewportStack.push([...this._viewport]);
  }
  restoreViewport() {
    const viewport = this._viewportStack.pop();
    if (viewport) this.setViewport(...viewport);
  }
  setViewport(x: number, y: number, width: number, height: number) {
    this._viewport = [x, y, width, height];
    this.gl.viewport(x, y, width, height);
  }

  dispose() {
    this._pendingPrograms.forEach(pending => pending.shaders.forEach(shader => this.gl.deleteShader(shader)));
    this._pendingPrograms.clear();
    this._programErrors.clear();
    this._programs.forEach((program) => this.gl.deleteProgram(program));
    this._programs.clear();
    this._compilationRecords = [];
    this.emptyTexture.dispose(this.gl);
  }
}

export class FrameBuffer {
  private _frameBuffer?: WebGLFramebuffer;
  private _attachments: Texture2D[] = [];
  attach(texture: Texture2D) {
    this._attachments = [texture];
  }
  bind(renderer: WebGLDevice, textures?: Texture2D[], target: number = renderer.gl.FRAMEBUFFER) {
    const gl = renderer.gl;
    const previousCount = this._attachments.length;
    if (textures) this._attachments = textures;
    textures = this._attachments;
    this._frameBuffer ||= gl.createFramebuffer()!;
    gl.bindFramebuffer(target, this._frameBuffer);
    for (let index = textures.length; index < previousCount; index++) gl.framebufferTexture2D(target, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, null, 0);
    textures.forEach((texture, index) => {
      texture.bind(gl, 0);
      gl.framebufferTexture2D(
        target,
        gl.COLOR_ATTACHMENT0 + index,
        gl.TEXTURE_2D,
        texture.getWebGLTexture(gl),
        0
      );
    });
    if (target !== gl.READ_FRAMEBUFFER) gl.drawBuffers(textures.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
  }
  dispose(renderer: WebGLDevice) {
    if (this._frameBuffer) renderer.gl.deleteFramebuffer(this._frameBuffer);
    this._frameBuffer = undefined;
  }
}
