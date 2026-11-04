import type TextureState from '../scene/TextureState.js';
import { textureWrapIndex } from '../scene/TextureState.js';

export const DEFAULT_MAX_TEXTURE_ARRAY_BYTES = 384 * 1024 * 1024;

export interface MaterialTableOptions {
  /** Native binding arrays: retain separate images instead of packing atlas pages. Default false. */
  independentTextures?: boolean;
  // Native descriptors can expose several logical samplers over one owned image.
  textureSource?: (texture: TextureState) => object;
  maxTextureArrayBytes?: number;
  maxTextureArrayLayers?: number;
  maxTextureDimension2D?: number;
}

export interface TextureAtlasStats {
  estimatedBytes: number;
  height: number;
  layers: number;
  packTimeMs: number;
  scale: number;
  sourcePixels: number;
  textureCount: number;
  width: number;
}

export interface AtlasPlacement {
  height: number;
  index: number;
  layer: number;
  width: number;
  x: number;
  y: number;
}

interface AtlasShelf {
  height: number;
  x: number;
  y: number;
}

interface AtlasPage {
  nextY: number;
  placements: AtlasPlacement[];
  shelves: AtlasShelf[];
}

/**
 * Packs material textures into a small 2D-array atlas.
 *
 * The input rectangles are sorted from tallest/largest to smallest, then
 * placed with a shelf allocator. Each atlas layer contains horizontal shelves;
 * a texture is inserted into the first shelf with enough remaining width, or a
 * new shelf is opened below the existing ones. A new array layer is allocated
 * only when none of the current layers has enough room.
 *
 * `makeTextureArray` first tries this packing at full resolution. If the result
 * exceeds the adapter layer limit or the configured memory budget, it performs
 * a binary search for the largest uniform scale that fits. This preserves full
 * resolution whenever packing alone is sufficient and degrades predictably on
 * constrained hardware.
 *
 * The returned placements keep the original logical texture indices. Shaders
 * use per-texture atlas metadata instead of treating the logical index as the
 * physical array layer.
 */
function packTextureAtlas(
  textures: TextureState[],
  pageSize: number,
  scale: number
) {
  const pages: AtlasPage[] = [];
  const placements = new Array<AtlasPlacement>(textures.length);
  const items = textures
    .map((texture, index) => ({
      height: Math.max(1, Math.floor(texture.image.height * scale)),
      index,
      width: Math.max(1, Math.floor(texture.image.width * scale))
    }))
    .sort((a, b) => b.height - a.height || b.width - a.width);

  for (const item of items) {
    let placement: AtlasPlacement | undefined;
    for (let layer = 0; layer < pages.length && !placement; layer++) {
      const page = pages[layer];
      for (const shelf of page.shelves) {
        if (
          item.height <= shelf.height &&
          shelf.x + item.width <= pageSize
        ) {
          placement = {
            height: item.height, index: item.index, width: item.width,
            layer,
            x: shelf.x,
            y: shelf.y
          };
          shelf.x += item.width;
          break;
        }
      }
      if (!placement && page.nextY + item.height <= pageSize) {
        placement = {
          height: item.height, index: item.index, width: item.width,
          layer,
          x: 0,
          y: page.nextY
        };
        page.shelves.push({
          height: item.height,
          x: item.width,
          y: page.nextY
        });
        page.nextY += item.height;
      }
    }

    if (!placement) {
      const layer = pages.length;
      placement = { height: item.height, index: item.index, width: item.width, layer, x: 0, y: 0 };
      pages.push({
        nextY: item.height,
        placements: [],
        shelves: [{ height: item.height, x: item.width, y: 0 }]
      });
    }
    pages[placement.layer].placements.push(placement);
    placements[item.index] = placement;
  }

  return { pages, placements };
}


export function planTextureAtlas(textures: TextureState[], mapColorLinear: number[], options: MaterialTableOptions = {},
  floatStorage = mapColorLinear.some(value => !!value)) {
  const bytesPerPixel = floatStorage ? 8 : 4;
  if (!textures.length) return { independentTextures: !!options.independentTextures, pages: [] as AtlasPage[], placements: [] as AtlasPlacement[],
    width: 1, height: 1, floatStorage, bytesPerPixel, mapInfo: [] as number[],
    mapTransform: [] as number[], mapWrap: [] as number[], mapUvChannel: [] as number[], mapColorLinear,
    stats: {estimatedBytes: 0, height: 1, layers: 0, packTimeMs: 0, scale: 1,
      sourcePixels: 0, textureCount: 0, width: 1} };
  if (options.independentTextures) {
    const budget = options.maxTextureArrayBytes ?? DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
    const dimension = options.maxTextureDimension2D ?? Infinity;
    const sources = new Map<object, Map<boolean, number>>(), unique: number[] = [];
    const layers = textures.map((texture, index) => {
      const source = options.textureSource?.(texture) ?? texture.image;
      let flips = sources.get(source);
      if (!flips) { flips = new Map(); sources.set(source, flips); }
      let layer = flips.get(texture.flipY);
      if (layer === undefined) { layer = unique.length; flips.set(texture.flipY, layer); unique.push(index); }
      return layer;
    });
    const extents = (scale: number) => textures.map((texture, index) => ({index, layer: layers[index], x: 0, y: 0,
      width: Math.max(1, Math.floor(texture.image.width * scale)), height: Math.max(1, Math.floor(texture.image.height * scale))}));
    const bytes = (items: AtlasPlacement[]) => unique.reduce((sum, index) => sum + items[index].width * items[index].height * bytesPerPixel, 0);
    if (unique.length * bytesPerPixel > budget) throw new Error('Material textures cannot fit the budget even at 1×1.');
    let scale = textures.reduce((s, t) => Math.min(s, dimension / Math.max(t.image.width, t.image.height)), 1);
    if (bytes(extents(scale)) > budget) {
      let low = 0, high = scale;
      for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (bytes(extents(mid)) <= budget) low = mid; else high = mid; }
      scale = low;
    }
    const placements = extents(scale);
    const width = placements.reduce((n, p) => Math.max(n, p.width), 1), height = placements.reduce((n, p) => Math.max(n, p.height), 1);
    return {independentTextures: true, pages: unique.map(index => ({nextY: placements[index].height, placements: [placements[index]], shelves: [] as AtlasShelf[]})), placements,
      width, height, floatStorage, bytesPerPixel, mapInfo: placements.flatMap(p => [p.width, p.height, p.layer, 0]),
      mapTransform: textures.flatMap(t => [...t.uvScale, ...t.uvOffset]),
      mapWrap: textures.flatMap(t => [textureWrapIndex(t.wrapS), textureWrapIndex(t.wrapT)]),
      mapUvChannel: textures.map(t => t.uvChannel), mapColorLinear,
      stats: {estimatedBytes: bytes(placements), width, height, layers: unique.length, packTimeMs: 0, scale,
        sourcePixels: unique.reduce((n, i) => n + textures[i].image.width * textures[i].image.height, 0), textureCount: textures.length}};
  }
  const maxTextureArrayLayers = options.maxTextureArrayLayers ?? Infinity;
  const maxTextureDimension2D = options.maxTextureDimension2D ?? Infinity;
  const maxTextureArrayBytes =
    options.maxTextureArrayBytes ?? DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  const sourcePixels = textures.reduce(
    (sum, texture) => sum + texture.image.width * texture.image.height,
    0
  );
  const maxSourceDimension = textures.reduce(
    (max, texture) =>
      Math.max(max, texture.image.width, texture.image.height),
    1
  );
  const maxPageSizeFromBudget = Math.max(
    1,
    Math.floor(Math.sqrt(maxTextureArrayBytes / bytesPerPixel))
  );
  const pageSize = Math.max(
    1,
    Math.floor(
      Math.min(
        maxSourceDimension,
        maxTextureDimension2D,
        maxPageSizeFromBudget
      )
    )
  );
  const pageBytes = pageSize * pageSize * bytesPerPixel;
  const maxPageCount = Math.max(
    1,
    Math.min(
      maxTextureArrayLayers,
      Math.floor(maxTextureArrayBytes / pageBytes)
    )
  );
  const maxScale = Math.min(1, pageSize / maxSourceDimension);
  let packed = packTextureAtlas(textures, pageSize, maxScale);
  let scale = maxScale;

  if (packed.pages.length > maxPageCount) {
    let low = 0;
    let high = maxScale;
    let bestPacked: ReturnType<typeof packTextureAtlas> | undefined;
    let bestScale = 0;
    for (let i = 0; i < 14; i++) {
      const candidateScale = (low + high) / 2;
      const candidate = packTextureAtlas(
        textures,
        pageSize,
        candidateScale
      );
      if (candidate.pages.length <= maxPageCount) {
        low = candidateScale;
        bestScale = candidateScale;
        bestPacked = candidate;
      } else {
        high = candidateScale;
      }
    }
    if (!bestPacked) {
      throw new Error(
        `Unable to fit ${textures.length} textures into ${maxPageCount} atlas layers.`
      );
    }
    packed = bestPacked;
    scale = bestScale;
  }

  const atlasWidth = packed.placements.reduce((max, placement) => Math.max(max, placement.x + placement.width), 1);
  const atlasHeight = packed.placements.reduce((max, placement) => Math.max(max, placement.y + placement.height), 1);
  // mapInfo = [uvScale.x, uvScale.y, layer + uvOffset.x, uvOffset.y].
  // Packing layer and X offset into one float keeps the shader metadata to one
  // vec4 per logical texture; floor(z) restores the layer and fract(z) the X.
  const mapInfo = packed.placements.flatMap((placement) => {
    const offsetX = (placement.x + 0.5) / atlasWidth;
    const offsetY = (placement.y + 0.5) / atlasHeight;
    return [
      Math.max(placement.width - 1, 0) / atlasWidth,
      Math.max(placement.height - 1, 0) / atlasHeight,
      placement.layer + offsetX,
      offsetY
    ];
  });

  return { independentTextures: false, pages: packed.pages, placements: packed.placements, width: atlasWidth, height: atlasHeight,
    floatStorage, bytesPerPixel, mapInfo,
    mapTransform: textures.flatMap(texture => [texture.uvScale[0], texture.uvScale[1], texture.uvOffset[0], texture.uvOffset[1]]),
    mapWrap: textures.flatMap(texture => [textureWrapIndex(texture.wrapS), textureWrapIndex(texture.wrapT)]),
    mapUvChannel: textures.map(texture => texture.uvChannel), mapColorLinear,
    stats: { estimatedBytes: atlasWidth * atlasHeight * packed.pages.length * bytesPerPixel,
      height: atlasHeight, layers: packed.pages.length, packTimeMs: 0, scale, sourcePixels,
      textureCount: textures.length, width: atlasWidth } };
}
export type TextureAtlasPlan = ReturnType<typeof planTextureAtlas>;
