/** Transfer function for material color slots; data-map channels remain linear. */
export type TextureColorSpace = 'srgb' | 'linear';

/** Addressing of coordinates outside a material texture's [0, 1] range. */
export type TextureWrapMode = 'repeat' | 'clamp-to-edge' | 'mirrored-repeat';

export function textureWrapIndex(mode: TextureWrapMode): number {
  return mode === 'clamp-to-edge' ? 1 : mode === 'mirrored-repeat' ? 2 : 0;
}

export interface TextureImageSize { width: number; height: number; }

// Pixel/image storage belongs to the platform adapter. Shared code only needs
// dimensions, identity and sampling metadata; it never owns a browser image.
export default class TextureState {
  image: TextureImageSize;
  /** True only for a UDIM logical image. Internal portable sampling marker. */
  readonly udim?: boolean;
  /** Normal-slot tangent frame. Default 'cotangent'; 'materialx' decodes against normalized world-space primary tangents, including a geometric-normal fallback for black texels. */
  normalMapFrame: 'cotangent' | 'materialx' = 'cotangent';
  version = 0;
  /** Flip the image vertically when uploading. Default `false`. */
  flipY: boolean = false;
  /** UV repeat applied before sampling this texture. Default `[1, 1]`. */
  uvScale: [number, number] = [1, 1];
  /** UV translation applied after repeat and before wrapping. Default `[0, 0]`. */
  uvOffset: [number, number] = [0, 0];
  /** Horizontal material-texture addressing after UV scale/offset. Default `'repeat'`. */
  wrapS: TextureWrapMode = 'repeat';
  /** Vertical material-texture addressing after UV scale/offset. Default `'repeat'`. */
  wrapT: TextureWrapMode = 'repeat';
  /** Material color encoding. Default undefined: sRGB for images/bytes, linear for float/integer HDR data. Data-map channels ignore this option. */
  colorSpace?: TextureColorSpace;
  /** Geometry UV set used by this texture (Three.js Texture.channel). Default `0`. */
  uvChannel: 0 | 1 = 0;
  constructor(image: TextureImageSize, udim = false) { this.image = image; if (udim) this.udim = true; }

  /**
   * Call after editing image pixels or UV array elements in place. Increments
   * version so the next render refreshes all materials, lights and backgrounds
   * using this texture. Assigning a new image, UV array, flipY, wrapS, wrapT, colorSpace or
   * uvChannel is detected automatically.
   */
  markUpdated() {
    this.version++;
    return this;
  }
}
