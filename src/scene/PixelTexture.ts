import TextureState from './TextureState.js';
import type { TextureDataSource } from './textureData.js';

// Separate native pixel ownership from the portable image-dimension record.
export default class PixelTexture extends TextureState {
  readonly pixels: TextureDataSource;
  constructor(pixels: TextureDataSource, udim = false) {
    super({width: pixels.width, height: pixels.height}, udim);
    this.pixels = pixels;
  }
}
