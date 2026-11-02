import type { Settings } from './store';
import { STUDIO_PRESETS } from './engine/studio';
import { SKY_TIME_RANGE } from './engine/sky';

type Parser = (raw: string) => Settings[keyof Settings] | undefined;
const boolean: Parser = (raw) => raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : undefined;
const choice = (...values: string[]): Parser => (raw) => values.includes(raw) ? raw : undefined;
const number = (min: number, max = Infinity, integer = false): Parser => (raw) => {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : undefined;
};
const output = choice('final', 'albedo', 'normal', 'depth', 'position', 'roughness', 'diffuseAlbedo', 'specularAlbedo', 'id', 'motion');
const nullable = (parse: Parser): Parser => (raw) => raw === 'null' ? null : parse(raw);
const color: Parser = (raw) => /^#[0-9a-f]{6}$/i.test(raw) ? raw : undefined;

/** Camera state is model-specific and continues to be restored locally. */
const parsers = {
  lighting: choice('environment', 'studio'),
  studioPreset: choice(...STUDIO_PRESETS.map((p) => p.id)),
  studioIntensity: number(0, 20), studioRotation: number(0, 360),
  studioSize: number(0.1, 4), studioAmbient: number(0, 2), studioAmbientColor: color,
  envId: (raw: string) => /^[a-z0-9_-]+$/i.test(raw) ? raw : undefined,
  envIntensity: number(0), envRotation: number(0, 360), skyTime: number(SKY_TIME_RANGE[0], SKY_TIME_RANGE[1]), envResolution: choice('1k', '2k', '4k'),
  background: choice('environment', 'grounded', 'color', 'transparent'), backgroundColor: color,
  groundedHeight: nullable(number(Number.MIN_VALUE)), groundedRadius: nullable(number(Number.MIN_VALUE)),
  groundShadow: boolean, groundOpacity: number(0, 1),
  caustics: boolean,causticLightTracing:boolean,causticPhotonMapping:boolean,
  maxSamples: number(1, Infinity, true), bounces: number(1, Infinity, true), resolutionScale: number(Number.MIN_VALUE, 1), resolutionHeight: nullable(number(1, 16384, true)),
  samplingPattern: choice('sobol', 'zsobol', 'random'), bvhBuilder: choice('tinybvh', 'builtin'), clamping: number(0),
  denoise: boolean, denoiseModel: choice('jnlm', 'standard', 'small', 'cleanAuxLarge'), denoiseWhileConverging: boolean,
  jnlmStrength: number(0.1, 3), jnlmSearchRadius: number(1, 16, true), jnlmPatchRadius: number(0, 3, true),
  jnlmAlbedoBandwidth: number(0.0001, 10), jnlmNormalBandwidth: number(0.0001, 10), jnlmIterations: number(1, 4, true),
  oidnModel: choice('standard', 'small', 'cleanAuxLarge'),
  oidnMaxTileSize: (raw: string) => ['0', '256', '512', '1024', '2048'].includes(raw) ? Number(raw) : undefined,
  toneMapping: choice('agx', 'aces', 'cineon', 'reinhard', 'linear'), hdrOutputEnabled: boolean,
  exposure: number(0), contrast: number(0), saturation: number(0), temperature: number(-1, 1), tint: number(-1, 1),
  bloomIntensity: number(0), bloomThreshold: number(0), bloomRadius: number(0, 1), vignette: number(0, 1),
  output: (raw: string) => output(raw === 'shadow' ? 'final' : raw),
  aovDepthFar: number(0.01, 10000), aovPositionScale: number(0.001, 10000), aovMotionScale: number(0.01, 1000), aovIdComponent: choice('object', 'instance', 'material', 'primitive'), previewEnabled: boolean, previewMaxResolutionScale: number(Number.MIN_VALUE, 1)
} satisfies Partial<Record<keyof Settings, Parser>>;

export const URL_SETTINGS_FIELDS = Object.keys(parsers) as (keyof typeof parsers)[];

/** Valid query values win over hash values; omitted/invalid values leave local preferences alone. */
export function readURLSettings(search = location.search, hash = location.hash): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const params of [new URLSearchParams(hash.slice(1)), new URLSearchParams(search)]) {
    for (const key of URL_SETTINGS_FIELDS) {
      const raw = params.get(key);
      if (raw === null) continue;
      const value = parsers[key](raw);
      if (value !== undefined) out[key] = value;
    }
  }
  return out as Partial<Settings>;
}
