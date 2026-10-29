import { allocateAovId, validateAovId } from '../renderer/aov.js';
import type { Vec2 } from '../types.js';
import type { ColorRGB } from '../types.js';
import type TextureState from './TextureState.js';
import type { ThinFilmMapChannel } from './thinFilmParameters.js';
import { materialDefault, applyMaterialParams } from './openPbrSchema.js';

export type UVProjection = 'none' | 'triplanar' | 'spherical' | 'cylindrical';
export type MaterialAlphaMode = 'auto' | 'opaque' | 'mask' | 'blend';

export type { MaterialTextureName } from './materialTextureNames.js';

// Shared material state; browser texture types are refined by the public facade.
const aovIds = new WeakMap<MaterialState, number>();
export default class MaterialState {
  /** Stable unsigned material ID, excluding 0xFFFFFFFF. Default process-unique monotonic ID; assign before committing the scene. */
  get aovId(): number { return aovIds.get(this)!; }
  set aovId(value: number) { aovIds.set(this, validateAovId(value)); }
  /** Creates a material. Omitted properties use their documented defaults. */
  constructor(params: MaterialStateParams = {}) {
    aovIds.set(this, allocateAovId());
    applyMaterialParams(this, params);
    if (params.aovId !== undefined) this.aovId = validateAovId(params.aovId);
  }

  // Base
  /** Multiplier of diffuse reflection and metallic normal-incidence color; does not scale dielectric specular, transmission or subsurface. Default `1`. */
  baseWeight: number = materialDefault('baseWeight');
  /** Diffuse/metal color. Default `[0.8, 0.8, 0.8]`. */
  baseColor: ColorRGB = materialDefault('baseColor');
  /** Oren-Nayar style roughness of the diffuse lobe. Default `0`. */
  baseDiffuseRoughness: number = materialDefault('baseDiffuseRoughness');
  /** `0` dielectric, `1` metal. Default `0`. */
  baseMetalness: number = materialDefault('baseMetalness');

  // Specular
  /** Dielectric specular strength (via IOR) and overall metallic Fresnel multiplier. Default `1`. */
  specularWeight: number = materialDefault('specularWeight');
  /** Dielectric specular tint and metallic F82 near-grazing tint. Default `[1, 1, 1]`. */
  specularColor: ColorRGB = materialDefault('specularColor');
  /** Microfacet roughness, `0` mirror to `1` rough; retains source perceptual roughness in `gltf` anisotropy mode. Default `0.3`. */
  specularRoughness: number = materialDefault('specularRoughness');
  /** Index of refraction. Default `1.5`. */
  specularIor: number = materialDefault('specularIor');
  /**
   * GGX anisotropy strength, 0 to 1 (requires tangents); native OpenPBR or source glTF strength according to specularAnisotropyModel. Default `0`.
   * @deprecated Use specularRoughnessAnisotropy.
   */
  specularAnisotropy: number = materialDefault('specularAnisotropy');

  // Transmission
  /** `1` makes the dielectric base fully transmissive (glass). Default `0`. */
  transmissionWeight: number = materialDefault('transmissionWeight');
  /** Transmission tint, or the medium color at `transmissionDepth`. Default `[1, 1, 1]`. */
  transmissionColor: ColorRGB = materialDefault('transmissionColor');
  /** Depth at which `transmissionColor` is reached; `0` tints at the surface. Default `0`. */
  transmissionDepth: number = materialDefault('transmissionDepth');
  /** Volume scattering color of the transmissive medium. Default `[0, 0, 0]`. */
  transmissionScatter: ColorRGB = materialDefault('transmissionScatter');
  /** Henyey-Greenstein anisotropy of the medium, -1 to 1. Default `0`. */
  transmissionScatterAnisotropy: number = materialDefault('transmissionScatterAnisotropy');
  /** Dispersion strength; `> 0` enables spectral rendering. Default `0`. */
  transmissionDispersionScale: number = materialDefault('transmissionDispersionScale');
  /** Abbe number controlling dispersion. Default `20`. */
  transmissionDispersionAbbeNumber: number = materialDefault('transmissionDispersionAbbeNumber');

  // Subsurface
  /** Subsurface scattering weight. Default `0`. */
  subsurfaceWeight: number = materialDefault('subsurfaceWeight');
  /** Subsurface color. Default `[0.8, 0.8, 0.8]`. */
  subsurfaceColor: ColorRGB = materialDefault('subsurfaceColor');
  /** Mean free path in scene units. Default `1`. */
  subsurfaceRadius: number = materialDefault('subsurfaceRadius');
  /** Per-channel multiplier of `subsurfaceRadius`. Default `[1, 0.5, 0.25]`. */
  subsurfaceRadiusScale: ColorRGB = materialDefault('subsurfaceRadiusScale');
  /**
   * Scattering anisotropy, -1 to 1. Default `0`.
   * @deprecated Use subsurfaceScatterAnisotropy.
   */
  subsurfaceAnisotropy: number = materialDefault('subsurfaceAnisotropy');

  // Fuzz (sheen)
  /** Fuzz (sheen) layer weight. Default `0`. */
  fuzzWeight: number = materialDefault('fuzzWeight');
  /** Fuzz reflection color; substrate attenuation uses white fuzz albedo. Default `[1, 1, 1]`. */
  fuzzColor: ColorRGB = materialDefault('fuzzColor');
  /** Fuzz roughness; imported from Three.js `sheenRoughness`. Default `0.5`. */
  fuzzRoughness: number = materialDefault('fuzzRoughness');

  // Coat
  /** Clear coat weight. Default `0`. */
  coatWeight: number = materialDefault('coatWeight');
  /** Squared coat transmittance at normal incidence; colors the base and emission, not coat reflection. Default `[1, 1, 1]`. */
  coatColor: ColorRGB = materialDefault('coatColor');
  /** Coat roughness. Default `0`. */
  coatRoughness: number = materialDefault('coatRoughness');
  /**
   * OpenPBR GGX coat anisotropy, 0 to 1; uses the base geometry tangent. Default `0`.
   * @deprecated Use coatRoughnessAnisotropy.
   */
  coatAnisotropy: number = materialDefault('coatAnisotropy');
  /** Coat index of refraction. Default `1.6`. */
  coatIor: number = materialDefault('coatIor');
  /** Internal-reflection darkening: 0 compensates darkening, 1 is physical; absorption remains at 0. Default `1`. */
  coatDarkening: number = materialDefault('coatDarkening');

  // Thin film
  /** Thin-film interference weight (iridescence). Default `0`. */
  thinFilmWeight: number = materialDefault('thinFilmWeight');
  /** Film thickness in micrometres; maximum endpoint when thinFilmMap is present. Default `0.5`. */
  thinFilmThickness: number = materialDefault('thinFilmThickness');
  /** Film index of refraction. Default `1.4`. */
  thinFilmIor: number = materialDefault('thinFilmIor');

  /** Thickness at a thinFilmMap sample of zero, in micrometres; ignored without a map. May exceed thinFilmThickness. Default `0`. */
  thinFilmThicknessMinimum: number = materialDefault('thinFilmThicknessMinimum');
  /** Linear channel sampled by thinFilmMap. Default `r`. */
  thinFilmMapChannel: ThinFilmMapChannel = materialDefault('thinFilmMapChannel');

  // Emission and geometry
  /** Emission color. Default `[1, 1, 1]`. */
  emissionColor: ColorRGB = materialDefault('emissionColor');
  /** Emitted radiance scale; `0` disables emission. Default `0`. */
  emissionLuminance: number = materialDefault('emissionLuminance');
  /**
   * Coverage, `1` opaque. See `alphaMode`. Default `1`.
   * @deprecated Use geometryOpacity.
   */
  opacity: number = materialDefault('opacity');
  /**
   * Treat the surface as an infinitely thin shell (leaves, paper). Default `false`.
   * @deprecated Use geometryThinWalled.
   */
  thinWalled: boolean = materialDefault('thinWalled');
  /** Disables geometric back-face culling and permits back-face emission. Default `false`. */
  doubleSided: boolean = materialDefault('doubleSided');

  // Textures
  /** Base color texture, multiplied with `baseColor` using Texture color encoding. Default `undefined`. */
  map?: TextureState;
  /** Standalone opacity texture sampled from its green channel, matching Three.js. Default `undefined`. */
  alphaMap?: TextureState;
  /**
   * Coverage for surface and shadow rays: `opaque` ignores alpha inputs,
   * `mask` uses binary alpha testing, `blend` retains fractional coverage.
   * `auto` derives the mode from the alpha inputs. Default `auto`.
   */
  alphaMode: MaterialAlphaMode = materialDefault('alphaMode');
  /** Alpha-test threshold for `mask` mode; equality is fully covered. Default `0`. */
  alphaCutoff: number = materialDefault('alphaCutoff');
  /** Emission texture multiplied with `emissionColor`. Default `undefined`. */
  emissiveMap?: TextureState;
  /** Tangent-space normal map. Default `undefined`. */
  normalMap?: TextureState;
  /** Normal map strength per axis. Default `[1, 1]`. */
  normalScale: Vec2 = materialDefault('normalScale');
  /** glTF-compatible B=metalness, G=specular roughness texture. Default `undefined`. */
  metallicRoughnessMap?: TextureState;
  /** Standalone roughness texture sampled from its green channel. Default `undefined`. */
  roughnessMap?: TextureState;
  /** Standalone metalness texture sampled from its blue channel. Default `undefined`. */
  metalnessMap?: TextureState;
  /** Multiplies transmission weight using the texture's red channel. Default `undefined`. */
  transmissionMap?: TextureState;
  /** Linear thickness-range texture; R and zero minimum preserve multiplication semantics. Default `undefined`. */
  thinFilmMap?: TextureState;

  /** Multiplies coatWeight by the linear red channel. Default `undefined`. */
  coatWeightMap?: TextureState;
  /** Multiplies coatRoughness by the linear green channel. Default `undefined`. */
  coatRoughnessMap?: TextureState;
  /** Multiplies fuzzColor by RGB channels using Texture color encoding. Default `undefined`. */
  fuzzColorMap?: TextureState;
  /** Multiplies fuzzRoughness by the linear alpha channel. Default `undefined`. */
  fuzzRoughnessMap?: TextureState;
  /** Multiplies specularWeight by the linear alpha channel. Default `undefined`. */
  specularWeightMap?: TextureState;
  /** Multiplies specularColor by RGB channels using Texture color encoding. Default `undefined`. */
  specularColorMap?: TextureState;


  /** Source convention for base specular anisotropy. `gltf` converts textured roughness and strength before coat roughening; `openpbr` uses native parameters. Default `openpbr`. */
  specularAnisotropyModel: 'openpbr' | 'gltf' = 'openpbr';
  /** Linear RG tangent direction and B strength multiplier for the base specular layer. Default `undefined`. */
  anisotropyMap?: TextureState;
  /** Independent tangent-space coat normal in linear RGB. Without a map, coat uses the surface normal before base normal mapping. Default `undefined`. */
  coatNormalMap?: TextureState;
  /** XY strength of coatNormalMap; independent of normalScale. Default `[1, 1]`. */
  coatNormalScale: Vec2 = materialDefault('coatNormalScale');
  /** Base direction rotation in radians, counter-clockwise in tangent/bitangent space after RG decoding. Default `0`. */
  specularAnisotropyRotation: number = 0;
  /** Coat direction rotation in radians relative to the geometry tangent. Default `0`. */
  coatAnisotropyRotation: number = 0;

  /** GGX roughness anisotropy in [0, 1]; native OpenPBR or source glTF strength according to specularAnisotropyModel. Requires tangents. Default `0`. */
  get specularRoughnessAnisotropy(): number { return this.specularAnisotropy; }
  set specularRoughnessAnisotropy(value: number) { this.specularAnisotropy = value; }

  /** OpenPBR coat GGX roughness anisotropy in [0, 1]. Default `0`. */
  get coatRoughnessAnisotropy(): number { return this.coatAnisotropy; }
  set coatRoughnessAnisotropy(value: number) { this.coatAnisotropy = value; }

  /** Subsurface scattering anisotropy in [-1, 1]. Default `0`. */
  get subsurfaceScatterAnisotropy(): number { return this.subsurfaceAnisotropy; }
  set subsurfaceScatterAnisotropy(value: number) { this.subsurfaceAnisotropy = value; }

  /** Surface coverage; alphaMode controls testing and blending. Default `1`. */
  get geometryOpacity(): number { return this.opacity; }
  set geometryOpacity(value: number) { this.opacity = value; }

  /** Treat the surface as an infinitely thin shell. Default `false`. */
  get geometryThinWalled(): boolean { return this.thinWalled; }
  set geometryThinWalled(value: boolean) { this.thinWalled = value; }

  // Renderer extensions
  /**
   * Invisible ground that only receives shadows, composited over the
   * background. Default `false`.
   */
  shadowCatcher: boolean = materialDefault('shadowCatcher');
  /** Displays emission without scattering or illuminating other surfaces. Default `false`. */
  unlit: boolean = materialDefault('unlit');
  /** Radius of rounded-edge shading (shader bevel) in scene units. `0` disables it. Default `0`. */
  bevelSize: number = materialDefault('bevelSize');
  /** How map alpha is used: ignored, opacity or transmission. Default `opaque`. */
  mapAlphaUsage: 'opaque' | 'alpha' | 'transmission' = materialDefault('mapAlphaUsage');
  /** Procedural UV projection for textures without (good) UVs. Default `none`. */
  uvProjection: UVProjection = materialDefault('uvProjection');
  /** UV scale used with `uvProjection`. Default `[1, 1]`. */
  uvProjectionScale: Vec2 = materialDefault('uvProjectionScale');

  // Displacement
  /** Height texture (red channel) for displacement. Default `undefined`. */
  displacementMap?: TextureState;
  /** Procedural UV projection for the displacement map. Default `none`. */
  displacementUvProjection: UVProjection = materialDefault('displacementUvProjection');
  /** UV scale used with `displacementUvProjection`. Default `1`. */
  displacementUvProjectionScale: number = materialDefault('displacementUvProjectionScale');
  /** Height multiplier in mesh-local coordinate units. Default `0.1`. */
  displacementScale: number = materialDefault('displacementScale');
  /** Offset added after scaling the height map, along the normal in mesh-local units; requires a displacement map. Default `0`. */
  displacementBias: number = materialDefault('displacementBias');
  /** Ray-marching step in mesh-local units; 0 automatically uses abs(displacementScale) / 32. Default `0`. */
  displacementStepSize: number = materialDefault('displacementStepSize');

}
export { materialAlphaModeConstants } from '../renderer/materialConstants.js';

export type ResolvedMaterialAlphaMode = Exclude<MaterialAlphaMode, 'auto'>;

export function resolveMaterialAlphaMode(
  material: MaterialState
): ResolvedMaterialAlphaMode {
  if (material.alphaMode !== 'auto') return material.alphaMode;
  if (material.alphaCutoff > 0) return 'mask';
  if (
    material.opacity < 1 ||
    material.mapAlphaUsage === "alpha" ||
    material.alphaMap
  ) {
    return 'blend';
  }
  return 'opaque';
}

export { materialKeys, materialTextureKeys, materialGeometryKeys, materialParamKeys, getMaterialHashKey, resetMaterialTextureId } from './openPbrSchema.js';

/** Optional material properties; defaults are documented on MaterialState. */
export type MaterialStateParams = Partial<MaterialState>;
