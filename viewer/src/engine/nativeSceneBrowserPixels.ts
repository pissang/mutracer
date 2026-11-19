import type { ImagePixels } from './nativeScene';

export const nativeSceneBrowserPixels: ImagePixels = image => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image as CanvasImageSource, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};
