import { FragmentShader, Shader, glsl } from './shader.js';
import { constants, WebGLDevice, Texture2D } from './webgl.js';
import normalizeRayTraceOutput from './glsl/normalizeRayTraceOutput.frag.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import WebGLRayTracePass from './WebGLRayTracePass.js';

type RayTraceInput =
  | 'colorTex'
  | 'albedoTex'
  | 'normalTex'
  | 'shadowCatcherTex';
type LayerOutput = 'foreground' | 'catcherBackground';
type RayTraceOutput = 'color' | 'albedo' | 'normal' | 'shadowCatcher';

/** Converts the additive ray tracing buffers into display/denoise textures. */
export class WebGLRayTraceOutputPass {
  private readonly _renderer: WebGLDevice;
  private readonly _pass: WebGLFullQuadPass<RayTraceInput | 'catcherMomentsTex', RayTraceOutput>;

  private readonly _layersPass: WebGLFullQuadPass<
    RayTraceInput | 'catcherBackgroundTex', LayerOutput
  >;

  constructor(renderer: WebGLDevice, floatAlbedo = false) {
    this._renderer = renderer;
    this._pass = new WebGLFullQuadPass('rayTraceOutput', renderer, {
      shader: normalizeRayTraceOutput,
      outputs: ['color', 'albedo', 'normal', 'shadowCatcher'],
      outputParams: {
        color: {
          type: constants.HALF_FLOAT,
          minFilter: constants.LINEAR,
          magFilter: constants.LINEAR
        },
        albedo: { type: floatAlbedo ? constants.HALF_FLOAT : constants.UNSIGNED_BYTE },
        normal: { type: constants.UNSIGNED_BYTE },
        shadowCatcher: { type: constants.HALF_FLOAT }
      }
    });
    this._layersPass = new WebGLFullQuadPass('rayTraceLayers', renderer, {
      shader: new FragmentShader({
        name: 'normalizeRayTraceLayers',
        outputs: ['foreground', 'catcherBackground'],
        uniforms: {
          colorTex: Shader.uniform('sampler2D'),
          albedoTex: Shader.uniform('sampler2D'),
          normalTex: Shader.uniform('sampler2D'),
          shadowCatcherTex: Shader.uniform('sampler2D'),
          catcherBackgroundTex: Shader.uniform('sampler2D'),
          sampleCount: Shader.uniform('float', 1)
        },
        main: glsl`
void main() {
  vec4 light = sample_colorTex(v_Texcoord);
  vec4 mask = sample_shadowCatcherTex(v_Texcoord);
  vec4 background = sample_catcherBackgroundTex(v_Texcoord);
  float hit = sample_albedoTex(v_Texcoord).a;
  // Full spectral beauty has three wavelength contributions per shadow sample.
  float contributions = max(sample_normalTex(v_Texcoord).a, 1.0) / sampleCount;
  float foregroundHit = max(hit - mask.b * contributions, 0.0);
  out_foreground = vec4(
    (light.rgb - background.rgb * contributions)
      / (foregroundHit > 0.0 ? foregroundHit : sampleCount),
    clamp((light.a - background.a) / sampleCount, 0.0, 1.0)
  );
  out_catcherBackground = background / sampleCount;
}`
      }),
      outputs: ['foreground', 'catcherBackground'],
      outputParams: {
        foreground: { type: constants.HALF_FLOAT },
        catcherBackground: { type: constants.HALF_FLOAT }
      }
    });
  }

  setSize(width: number, height: number) {
    this._pass.setSize(width, height);
    this._layersPass.setSize(width, height);
  }

  setSampleCount(sampleCount: number) {
    this._pass.setUniform('sampleCount', Math.max(sampleCount, 1));
    this._layersPass.setUniform('sampleCount', Math.max(sampleCount, 1));
  }

  createPass(rayTracePass: WebGLRayTracePass) {
    this._pass.setOutputs(rayTracePass.hasShadowCatcher() ? ['color', 'albedo', 'normal', 'shadowCatcher'] : ['color', 'albedo', 'normal']);
    this._pass.createPass(
      {
        colorTex: rayTracePass.getOutput('color'),
        albedoTex: rayTracePass.getOutput('albedo'),
        normalTex: rayTracePass.getOutput('normal'),
        shadowCatcherTex: rayTracePass.hasShadowCatcher()
          ? rayTracePass.getOutput('shadowCatcher')
          : this._renderer.emptyTexture,
        catcherMomentsTex: rayTracePass.hasShadowCatcher()
          ? rayTracePass.getOutput('catcherMoments')
          : this._renderer.emptyTexture
      },
      undefined,
      { clear: true }
    );
    if (rayTracePass.hasShadowCatcher()) {
      this._layersPass.setOutputs(['foreground', 'catcherBackground']);
      this._layersPass.createPass({
        colorTex: rayTracePass.getOutput('color'),
        albedoTex: rayTracePass.getOutput('albedo'),
        normalTex: rayTracePass.getOutput('normal'),
        shadowCatcherTex: rayTracePass.getOutput('shadowCatcher'),
        catcherBackgroundTex: rayTracePass.getOutput('catcherBackground')
      }, undefined, { clear: true });
    } else {
      this._layersPass.setOutputs([]);
    }
  }

  getOutput(label: RayTraceOutput | LayerOutput): Texture2D {
    return label === 'foreground' || label === 'catcherBackground'
      ? this._layersPass.getOutput(label) ?? this._renderer.emptyTexture : this._pass.getOutput(label) ?? this._renderer.emptyTexture;
  }

  retainOutput(texture: Texture2D) { this._pass.retainOutput(texture); this._layersPass.retainOutput(texture); }
  releaseOutput(texture: Texture2D) { this._pass.releaseOutput(texture); this._layersPass.releaseOutput(texture); }

  getMemoryBytes() { return this._pass.getMemoryBytes() + this._layersPass.getMemoryBytes(); }

  dispose() {
    this._pass.dispose();
    this._layersPass.dispose();
  }
}

