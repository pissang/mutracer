import { isProceduralSkyImage } from '../scene/skyParameters.js';
import MaterialData from './MaterialData.js';
import { packMaterialBuffer } from './materialLayout.js';
import { repackMaterialParams } from './materialParams.js';
import type { MaterialTableOptions, TextureAtlasStats, TextureAtlasPlan, AtlasPlacement } from './textureAtlas.js';
import { writeAtlasPixel, writeRawAtlasPlacement } from './textureAtlasPixels.js';
import { float16Bits } from './float16.js';
import {createCanvas} from '../util/canvas.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import {
  Texture2DArray as WebGLTexture2DArray,
  constants,
  Texture2D,
  type TexturePixelSource
} from './webgl.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type {MaterialGraphState} from './materialGraph/state.js';
import {MATERIAL_FLOAT_COUNT} from './materialLayoutSchema.js';
import { isTextureDataSource } from '../scene/Texture.js';
import type Texture from '../scene/Texture.js';
import { commonNearestFloatProps, setDataTexture } from './dataTextureUtil.js';
import type { SceneLight } from '../scene/Scene.js';

export { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from './textureAtlas.js';
export type { MaterialTableOptions, TextureAtlasStats } from './textureAtlas.js';
export { materialUsesMedium } from './materialParams.js';
export { uvProjectionConstants } from './materialConstants.js';

function createAtlasCanvas(width: number, height: number) {
  return createCanvas(width, height);
}

function createDataAtlasPage(
  width: number,
  height: number,
  page: TextureAtlasPlan['pages'][number],
  textures: Texture[],
  floatStorage: boolean
): TexturePixelSource {
  const data = floatStorage ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  // Retain the same Canvas composition for DOM layers, including straight-alpha
  // readback. Raw sources never pass through Canvas or its color conversion.
  const domPlacements = page.placements.filter(p => !isTextureDataSource(textures[p.index].image));
  if (domPlacements.length) {
    const canvas = createAtlasCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create a canvas for the texture atlas.');
    for (const placement of domPlacements) drawAtlasImage(context, placement, textures[placement.index]);
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let i = 0; i < pixels.length; i++) writeAtlasPixel(data, i, floatStorage ? float16Bits(pixels[i] / 255) : pixels[i]);
  }
  for (const placement of page.placements) {
    const texture = textures[placement.index];
    const source = texture.image;
    if (!isTextureDataSource(source)) continue;
    writeRawAtlasPlacement(data, width, placement, {image: source, flipY: texture.flipY}, floatStorage);
  }
  return { data, width, height };
}

function drawAtlasImage(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  placement: AtlasPlacement,
  texture: Texture
) {
  if (texture.flipY) {
    context.save();
    context.translate(placement.x, placement.y + placement.height);
    context.scale(1, -1);
    context.drawImage(texture.image as CanvasImageSource, 0, 0, placement.width, placement.height);
    context.restore();
  } else {
    context.drawImage(texture.image as CanvasImageSource, placement.x, placement.y, placement.width, placement.height);
  }
}

function makeTextureArray(textures: Texture[], plan: TextureAtlasPlan, sRGB = false) {
  const packStart = performance.now();
  if (!textures.length) {
    return {
      stats: {
        estimatedBytes: 0,
        height: 1,
        layers: 0,
        packTimeMs: performance.now() - packStart,
        scale: 1,
        sourcePixels: 0,
        textureCount: 0,
        width: 1
      } satisfies TextureAtlasStats,
      texture: new WebGLTexture2DArray({
        width: 1,
        height: 1,
        sRGB,
        source: [],
        minFilter: constants.LINEAR,
        magFilter: constants.LINEAR,
        wrapS: constants.CLAMP_TO_EDGE,
        wrapT: constants.CLAMP_TO_EDGE
      })
    };
  }

  const dataBacked = textures.some(texture => isTextureDataSource(texture.image));
  const atlasWidth = plan.width, atlasHeight = plan.height, floatStorage = plan.floatStorage;
  const pages = plan.pages.map((page) => {
    if (dataBacked) {
      return createDataAtlasPage(atlasWidth, atlasHeight, page, textures, floatStorage);
    }
    const canvas = createAtlasCanvas(atlasWidth, atlasHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create a canvas for the texture atlas.');
    }
    for (const placement of page.placements) drawAtlasImage(context, placement, textures[placement.index]);
    return canvas;
  });

  if (plan.stats.scale < 0.999) console.warn(`Texture atlas downscaled to ${(plan.stats.scale * 100).toFixed(1)}% to fit the GPU budget.`);
  const texture = new WebGLTexture2DArray({
    width: atlasWidth,
    height: atlasHeight,
    sRGB,
    type: floatStorage ? constants.HALF_FLOAT : constants.UNSIGNED_BYTE,
    source: pages,
    flipY: false,
    flipYArray: pages.map(() => false),
    minFilter: constants.LINEAR,
    magFilter: constants.LINEAR,
    wrapS: constants.CLAMP_TO_EDGE,
    wrapT: constants.CLAMP_TO_EDGE
  });
  return {texture, stats: {...plan.stats, packTimeMs: performance.now() - packStart}};
}

export type { BufferData } from './materialBufferData.js';
import type { BufferData } from './materialBufferData.js';


class MaterialTable {
  texture: WebGLTexture2DArray | undefined;
  textureAtlasStats: TextureAtlasStats;

  defines: Record<string, number> = {};

  bufferData: BufferData;

  private _matBufferTex = new Texture2D(commonNearestFloatProps);
  private _materialBufferColumnsLog: number = 0;
  private _graphTextures: Texture[] = [];
  private _materialCount = 0;

  private _displacementMaps: Texture[] = [];
  private _lightTexturesIndices: number[] = [];

  constructor(
    materials: OpenPBRMaterial[],
    lights: SceneLight[],
    options: MaterialTableOptions = {},
    private readonly graphs?: MaterialGraphState
  ) {
    const packStart = performance.now();
    this._materialCount = materials.length;
    graphs?.request(materials);
    const graphTextures = graphs?.textures() ?? [];
    const data = new MaterialData(graphTextures.length ? [...materials, ...graphTextures.map(map => new OpenPBRMaterial({map}))] : materials,
      lights.map(light => light.type === 'RectLight' ? light.texture : undefined),
      texture => {
        const image = (texture as Texture).image;
        return Number(texture.colorSpace ? texture.colorSpace === 'linear' : isTextureDataSource(image) && !(image.data instanceof Uint8Array) && !(image.data instanceof Uint8ClampedArray));
      }, options, texture => {
        const image = (texture as Texture).image;
        return isTextureDataSource(image) && !(image.data instanceof Uint8Array) && !(image.data instanceof Uint8ClampedArray);
      });
    if (data.textures.some(texture => isProceduralSkyImage(texture.image))) throw new Error('ProceduralSky is only supported as an environment or background.');
    const {texture, stats} = makeTextureArray(data.textures as Texture[], data.atlas);
    this.texture = texture;
    this.textureAtlasStats = {...stats, packTimeMs: performance.now() - packStart};
    this._graphTextures = data.textures as Texture[];
    this.bufferData = data.bufferData;
    this.defines = data.defines;
    this._displacementMaps = data.displacementMaps as Texture[];
    this._lightTexturesIndices = data.lightTexturesIndices;

    this._updateBuffer();
  }


  /** Repack parameters with the same material slots and unchanged texture metadata. */
  repackParams(materials: OpenPBRMaterial[]) {
    this.graphs?.request(materials);
    repackMaterialParams(this.bufferData, materials);
    this._updateBuffer();
  }

  getBufferArray() {
    const packed = packMaterialBuffer(this.bufferData);
    const base = packed.length > this._materialCount * MATERIAL_FLOAT_COUNT ? packed.slice(0, this._materialCount * MATERIAL_FLOAT_COUNT) : packed;
    return this.graphs?.pack(base, this._graphTextures) ?? base;
  }

  refreshGraphParameters() { this._updateBuffer(); }

  getDisplacementMaps() {
    return this._displacementMaps;
  }

  getLightTexturesIndices() {
    return this._lightTexturesIndices;
  }

  private _updateBuffer() {
    this._materialBufferColumnsLog = setDataTexture(
      this._matBufferTex,
      this.getBufferArray(),
      4
    ).columnsLog;
  }

  setToPass(pass: {
    setUniform(label: string, value: unknown): unknown;
    setUniforms(values: Record<string, unknown>): void;
  }) {
    pass.setUniform('map', this.texture || null);
    pass.setUniform('mapInfo', this.bufferData.mapInfo);
    pass.setUniform('mapTransform', this.bufferData.mapTransform);
    pass.setUniform('mapWrap', this.bufferData.mapWrap);
    pass.setUniform('mapUvChannel', this.bufferData.mapUvChannel);
    pass.setUniform('mapColorLinear', this.bufferData.mapColorLinear);
    pass.setUniforms({
      materialBuffer: this._matBufferTex,
      materialBufferColumns: this._materialBufferColumnsLog
    });
  }

  dispose(gl: WebGL2RenderingContext) {
    this.texture?.dispose(gl);
    this._matBufferTex.dispose(gl);
  }
}

export default MaterialTable;
