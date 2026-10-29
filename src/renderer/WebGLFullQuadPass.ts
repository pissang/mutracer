import {scratchGLSLFunctions} from './scratchSampling.js';
import {setTextureRegion, textureRegion} from './textureRegion.js';
import { FragmentShader, type ShaderDefineValue } from './shader.js';
import {
  FrameBuffer,
  WebGLDevice,
  Texture2D,
  type TextureOptions,
  WebGLProgramBindings
} from './webgl.js';

export interface WebGLFullQuadPassOutput extends TextureOptions {}

export interface WebGLPassOptions {
  clear?: boolean;
  blend?: boolean;
  viewport?: { x: number; y: number; width: number; height: number };
  scissor?: { x: number; y: number; width: number; height: number };
}

/**
 * Explicit WebGL 2.0 render pass matching the lifecycle of WGPUFullQuadPass.
 * It owns its output textures and framebuffer; there is no render graph.
 */
export class WebGLFullQuadPass<I extends string, O extends string> {
  private readonly _renderer: WebGLDevice;
  private _bindings: WebGLProgramBindings;
  private _sourceShader: FragmentShader;
  private readonly _outputs: O[];
  private readonly _frameBuffer = new FrameBuffer();
  private _outputTextures = {} as Record<O, Texture2D>;
  private readonly _targetOutputs = new Map<object, Record<O, Texture2D>>();
  useTarget(target: object) {
    let outputs = this._targetOutputs.get(target);
    if (!outputs) this._targetOutputs.set(target, outputs = {} as Record<O, Texture2D>);
    this._outputTextures = outputs;
  }

  private _outputParams = {} as Record<O, WebGLFullQuadPassOutput>;
  private _reserveCapacity = false;
  private _capacityWidth = 1;
  private _capacityHeight = 1;
  private _width = 1;
  private _height = 1;
  private _renderToScreen = false;

  constructor(
    _label: string,
    renderer: WebGLDevice,
    options: {
      shader: FragmentShader;
      outputs?: O[];
      outputParams?: Partial<Record<O, WebGLFullQuadPassOutput>>;
    }
  ) {
    this._renderer = renderer;
    this._sourceShader = options.shader;
    this._bindings = new WebGLProgramBindings(this._samplingShader(options.shader));
    this._outputs = options.outputs || (options.shader.outputs as O[]);
    this.setOutputParams(
      Object.fromEntries(
        this._outputs.map((name) => [
          name,
          options.outputParams?.[name] || {}
        ])
      ) as Record<O, WebGLFullQuadPassOutput>
    );
  }

  setShader(shader: FragmentShader) {
    this._sourceShader = shader;
    this._bindings = new WebGLProgramBindings(this._samplingShader(
      shader, this._reserveCapacity, {...shader.uniforms, ...this._bindings.uniforms}, this._bindings.defines
    ));
  }

  reserveCapacity() {
    if (this._reserveCapacity) return;
    this._reserveCapacity = true;
    this._bindings = new WebGLProgramBindings(this._samplingShader(
      this._sourceShader, true, this._bindings.uniforms, this._bindings.defines
    ));
  }

  private _samplingShader(
    shader: FragmentShader,
    scratch = false,
    uniforms = shader.uniforms,
    defines = shader.defines
  ) {
    const textures = Object.keys(shader.uniforms).filter(name => shader.uniforms[name].type === 'sampler2D');
    uniforms = {...uniforms};
    if (scratch) for (const name of textures) uniforms[`${name}RegionSize`] = {type: 'ivec2', value: [1, 1]};
    const sampled = new FragmentShader({name: shader.name, outputs: shader.outputs, outputTypes: shader.outputTypes, defines, uniforms,
      includes: [{defines: {}, uniforms: {}, main: '', functions: [() => scratchGLSLFunctions(textures, scratch), ...shader.functions]}],
      main: shader.main});
    sampled.parallelCompile = shader.parallelCompile;
    return sampled;
  }

  setSize(width: number, height: number) {
    if (this._width === width && this._height === height) return;
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._capacityWidth = Math.max(this._capacityWidth, this._width);
    this._capacityHeight = Math.max(this._capacityHeight, this._height);
    this.setUniform('viewportSize', [this._width, this._height]);
  }

  setOutputs(outputs: readonly O[]) {
    for (const name of this._outputs) if (!outputs.includes(name)) {
      this._outputTextures[name]?.dispose(this._renderer.gl); delete this._outputTextures[name];
    }
    this._outputs.splice(0, this._outputs.length, ...outputs);
  }
  setOutputParams(params: Record<O, WebGLFullQuadPassOutput>) {
    this._outputParams = params;
  }

  setRenderToScreen(renderToScreen = true) {
    this._renderToScreen = renderToScreen;
  }

  setUniform(label: string, data: unknown) {
    return this._bindings.set(label, data);
  }

  setUniforms(values: Record<string, unknown>) {
    this._bindings.setUniforms(values);
  }

  getUniform(label: string) {
    return this._bindings.get(label);
  }

  setDefines(
    defines: Record<
      string,
      ShaderDefineValue | undefined
    >
  ) {
    let changed = false;
    for (const [name, value] of Object.entries(defines)) {
      const oldValue = this._bindings.defines[name];
      if (!value) {
        if (name in this._bindings.defines) {
          this._bindings.deleteDefine(name);
          changed = true;
        }
      } else if (oldValue !== value) {
        this._bindings.setDefine(name, value);
        changed = true;
      }
    }
    return changed;
  }

  private readonly _retainedOutputs = new Set<Texture2D>();
  retainOutput(texture: Texture2D) { if (Object.values(this._outputTextures).includes(texture)) this._retainedOutputs.add(texture); }
  releaseOutput(texture: Texture2D) {
    if (!this._retainedOutputs.delete(texture)) return;
    if (!Object.values(this._outputTextures).includes(texture)) texture.dispose(this._renderer.gl);
  }

  // Internal fixed-accumulation loader; transfer ownership to the selected target.
  loadDiagnosticOutputs(outputs: Partial<Record<O, Texture2D>>) {
    for (const name of Object.keys(outputs) as O[]) {
      this._outputTextures[name]?.dispose(this._renderer.gl);
      this._outputTextures[name] = outputs[name]!;
    }
  }

  getOutput(name: O) {
    return this._outputTextures[name];
  }

  private _prepareOutputs(explicitOutputs?: Partial<Record<O, Texture2D>>) {
    const gl = this._renderer.gl;
    for (const name of this._outputs) {
      const explicit = explicitOutputs?.[name];
      const current = this._outputTextures[name];
      const retainedResize = current && this._retainedOutputs.has(current) &&
        (current.width !== this._width || current.height !== this._height);
      const texture =
        explicit ||
        (retainedResize ? new Texture2D(this._outputParams[name]) : undefined) ||
        this._outputTextures[name] ||
        new Texture2D(this._outputParams[name]);
      texture.ensureStorage(
        gl,
        this._reserveCapacity ? this._capacityWidth : this._width,
        this._reserveCapacity ? this._capacityHeight : this._height,
        this._outputParams[name]
      );
      this._outputTextures[name] = texture;
      setTextureRegion(texture, this._width, this._height);
    }
  }

  isProgramReady(inputs?: Record<I, Texture2D>) {
    if (inputs) this._bindings.setUniforms(inputs);
    return this._renderer.isProgramCompiled(this._bindings.getProgram(this._renderer));
  }

  createPass(
    inputs: Record<I, Texture2D>,
    explicitOutputs?: Partial<Record<O, Texture2D>>,
    options: WebGLPassOptions = {}
  ) {
    const renderer = this._renderer;
    const gl = renderer.gl;

    if (this._renderToScreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this._prepareOutputs(explicitOutputs);
      this._frameBuffer.bind(
        renderer,
        this._outputs.map((name) => this._outputTextures[name])
      );
    }

    const viewport = options.viewport || {
      x: 0,
      y: 0,
      width: this._width,
      height: this._height
    };
    renderer.setViewport(
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height
    );

    // Clear the full accumulation target before enabling the tile scissor.
    // Otherwise every tile outside the first one retains stale camera data.
    if (options.clear) {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    if (options.scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        options.scissor.x,
        options.scissor.y,
        options.scissor.width,
        options.scissor.height
      );
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }

    if (this._reserveCapacity) for (const [name, texture] of Object.entries(inputs) as [string, Texture2D][]) {
      const region = textureRegion(texture);
      this.setUniform(`${name}RegionSize`, [region.width, region.height]);
    }
    this._bindings.setUniforms(inputs);
    if (!this._bindings.bind(renderer)) {
      gl.disable(gl.SCISSOR_TEST);
      return false;
    }
    gl.disable(gl.DEPTH_TEST);
    if (options.blend) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    return true;
  }

  releaseTarget(target: object) {
    const outputs = this._targetOutputs.get(target);
    if (!outputs) return;
    this._targetOutputs.delete(target);
    for (const texture of (Object.values(outputs) as Texture2D[])) texture.dispose(this._renderer.gl);
    if (outputs === this._outputTextures) this._outputTextures = {} as Record<O, Texture2D>;
  }

  getMemoryBytes(target?: object): number {
    const outputs = target ? this._targetOutputs.get(target) ?? {} : this._outputTextures;
    return Array.from(new Set([...Object.values(outputs) as Texture2D[], ...this._retainedOutputs]))
      .reduce((sum, texture) => sum + texture.getMemoryBytes(), 0);
  }

  dispose() {
    const gl = this._renderer.gl;
    (Array.from(new Set([this._outputTextures, ...this._targetOutputs.values()])).flatMap(outputs => Object.values(outputs)) as Texture2D[]).forEach((texture) =>
      texture.dispose(gl)
    );
    this._retainedOutputs.forEach(texture => texture.dispose(gl));
    this._retainedOutputs.clear();
    this._frameBuffer.dispose(this._renderer);
  }
}
