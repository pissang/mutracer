import type { DecodeImage } from './textures';
/** Browser/worker adapter; the shared parser and scene conversion do not use DOM. */
export const decodeImage: DecodeImage = async (bytes, path) => {
  const image = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' });
  try {
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
    if (!context) throw new Error(`Cannot decode ${path}`);
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  } finally { image.close(); }
};
