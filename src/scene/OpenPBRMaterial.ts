import MaterialState from './MaterialState.js';
import type Texture from './Texture.js';
import type MaterialGraph from './MaterialGraph.js';
export type { UVProjection, MaterialAlphaMode, ResolvedMaterialAlphaMode } from './MaterialState.js';
export type { MaterialTextureName } from './materialTextureNames.js';
export { materialAlphaModeConstants, resolveMaterialAlphaMode } from './MaterialState.js';
export { materialKeys, materialTextureKeys, materialGeometryKeys, materialParamKeys,
  getMaterialHashKey, resetMaterialTextureId } from './openPbrSchema.js';

/**
 * OpenPBR 1.1 surface material.
 *
 * Property names are camelCase OpenPBR inputs plus documented compatibility names
 * (https://academysoftwarefoundation.github.io/OpenPBR/). Colors are linear
 * RGB. Length-valued inputs (`transmissionDepth`, `subsurfaceRadius`) use
 * scene units; `thinFilmThickness` is in micrometres as in OpenPBR.
 *
 * ```ts
 * const gold = new OpenPBRMaterial({
 *   baseColor: [1.0, 0.78, 0.34], baseMetalness: 1, specularRoughness: 0.2
 * });
 * ```
 *
 * Edit parameters in place; the next `engine.update()` detects the changes.
 */
export default class OpenPBRMaterial extends MaterialState {
  /** Creates a material. Omitted properties use their documented defaults. */
  constructor(params: OpenPBRMaterialParams = {}) { super(params); this.graph = params.graph; }

  /** Optional MaterialX surface graph. Default undefined retains the constant material path. */
  graph?: MaterialGraph;

  /** Base color texture, multiplied with `baseColor` using Texture color encoding. Default `undefined`. */
  declare map?: Texture;
  /** Standalone opacity texture sampled from its green channel, matching Three.js. Default `undefined`. */
  declare alphaMap?: Texture;
  /** Emission texture multiplied with `emissionColor`. Default `undefined`. */
  declare emissiveMap?: Texture;
  /** Tangent-space normal map. Default `undefined`. */
  declare normalMap?: Texture;
  /** glTF-compatible B=metalness, G=specular roughness texture. Default `undefined`. */
  declare metallicRoughnessMap?: Texture;
  /** Standalone roughness texture sampled from its green channel. Default `undefined`. */
  declare roughnessMap?: Texture;
  /** Standalone metalness texture sampled from its blue channel. Default `undefined`. */
  declare metalnessMap?: Texture;
  /** Multiplies transmission weight using the texture's red channel. Default `undefined`. */
  declare transmissionMap?: Texture;
  /** Linear thickness-range texture; R and zero minimum preserve multiplication semantics. Default `undefined`. */
  declare thinFilmMap?: Texture;
  /** Multiplies coatWeight by the linear red channel. Default `undefined`. */
  declare coatWeightMap?: Texture;
  /** Multiplies coatRoughness by the linear green channel. Default `undefined`. */
  declare coatRoughnessMap?: Texture;
  /** Multiplies fuzzColor by RGB channels using Texture color encoding. Default `undefined`. */
  declare fuzzColorMap?: Texture;
  /** Multiplies fuzzRoughness by the linear alpha channel. Default `undefined`. */
  declare fuzzRoughnessMap?: Texture;
  /** Multiplies specularWeight by the linear alpha channel. Default `undefined`. */
  declare specularWeightMap?: Texture;
  /** Multiplies specularColor by RGB channels using Texture color encoding. Default `undefined`. */
  declare specularColorMap?: Texture;
  /** Linear RG tangent direction and B strength multiplier for the base specular layer. Default `undefined`. */
  declare anisotropyMap?: Texture;
  /** Independent tangent-space coat normal in linear RGB. Without a map, coat uses the surface normal before base normal mapping. Default `undefined`. */
  declare coatNormalMap?: Texture;
  /** Height texture (red channel) for displacement. Default `undefined`. */
  declare displacementMap?: Texture;
}

/** Optional material properties; defaults are documented on OpenPBRMaterial. */
export type OpenPBRMaterialParams = Partial<OpenPBRMaterial>;
