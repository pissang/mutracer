import Texture, {type TextureDataSource} from './Texture.js';

/** One image in a UDIM set. `udim` is `1001 + u + 10 * v`. */
export interface UdimTile {
  /** UDIM number. Must be an integer from 1001 through 1100. */
  udim: number;
  /** Loaded RGBA pixels for this tile. */
  image: TextureDataSource;
}

/** Returns the UDIM number for integer tile coordinates, or undefined outside the 10×10 domain. */
export function udimTileNumber(u: number, v: number): number | undefined {
  return Number.isInteger(u) && Number.isInteger(v) && u >= 0 && u < 10 && v >= 0 && v < 10 ? 1001 + u + 10 * v : undefined;
}

/** Returns the UDIM number selected by UV, or undefined for negative/out-of-range UVs. */
export function udimTileFromUv(u: number, v: number): number | undefined { return udimTileNumber(Math.floor(u), Math.floor(v)); }

function validateTile(tile: UdimTile) {
  if (!Number.isInteger(tile.udim) || tile.udim < 1001 || tile.udim > 1100) throw new RangeError('UDIM tile numbers must be integers from 1001 through 1100.');
  const {width, height, data} = tile.image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('UDIM tiles require positive integer dimensions.');
  if (data.length !== width * height * 4) throw new RangeError('UDIM tiles require RGBA pixel data.');
}

function compositeTiles(tiles: readonly UdimTile[]): TextureDataSource {
  if (!tiles.length) throw new RangeError('UdimTexture requires at least one tile.');
  tiles.forEach(validateTile);
  if (new Set(tiles.map(tile => tile.udim)).size !== tiles.length) throw new RangeError('UDIM tile numbers must be unique.');
  const tileWidth = Math.max(...tiles.map(tile => tile.image.width));
  const tileHeight = Math.max(...tiles.map(tile => tile.image.height));
  const float = tiles.some(tile => tile.image.data instanceof Float32Array || tile.image.data instanceof Int32Array);
  const width = tileWidth * 10, height = tileHeight * 10;
  const data = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (const tile of tiles) {
    const number = tile.udim - 1001, tileX = number % 10, tileY = Math.floor(number / 10), source = tile.image;
    const byteSource = source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray;
    for (let y = 0; y < tileHeight; y++) {
      const sy = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / tileHeight));
      for (let x = 0; x < tileWidth; x++) {
        const sx = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / tileWidth));
        const from = (sy * source.width + sx) * 4, to = (((tileY * tileHeight + y) * width) + tileX * tileWidth + x) * 4;
        for (let channel = 0; channel < 4; channel++) data[to + channel] = byteSource && float ? source.data[from + channel] / 255 : source.data[from + channel];
      }
    }
  }
  return {data, width, height};
}

/**
 * Material texture selected by integer UV tiles. Tile `(u, v)` uses number
 * `1001 + u + 10 * v`. Missing and out-of-range tiles sample transparent black.
 * Tiles are resampled to the largest tile size and share this texture's color
 * space, UV transform and UV channel. Only loaded RGBA pixel sources are accepted.
 */
export default class UdimTexture extends Texture {
  override readonly udim = true;
  /** Original tile descriptors. No default. */
  readonly tiles: readonly UdimTile[];
  constructor(tiles: readonly UdimTile[]) { super(compositeTiles(tiles)); this.tiles = tiles.slice(); }
  /** Rebuilds the logical image from the retained tile pixels and advances the version. */
  override markUpdated() { this.image = compositeTiles(this.tiles); return super.markUpdated(); }
}

export function isUdimTexture(texture: unknown): texture is UdimTexture { return texture instanceof UdimTexture; }
