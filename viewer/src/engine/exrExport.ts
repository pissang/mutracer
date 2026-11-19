import { DataTexture, FloatType, RGBAFormat } from 'three';
import { EXRExporter, NO_COMPRESSION } from 'three/addons/exporters/EXRExporter.js';
import type { Render } from '@meimu/mutracer';

export const EXR_MIME = 'image/x-exr';

export async function exportExr(render: Render, transparent: boolean): Promise<Blob> {
  const { width, height, data } = await render.readPixels('hdr');
  if (!width || !height) throw new Error('Render has no complete HDR image.');

  const stride = width * 4;
  const pixels = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    // Three's exporter takes bottom-up rows. OpenEXR uses associated alpha.
    const row = data.subarray(y * stride, (y + 1) * stride);
    const offset = (height - y - 1) * stride;
    for (let x = 0; x < stride; x += 4) {
      const alpha = transparent ? row[x + 3] : 1;
      pixels[offset + x] = row[x] * alpha;
      pixels[offset + x + 1] = row[x + 1] * alpha;
      pixels[offset + x + 2] = row[x + 2] * alpha;
      pixels[offset + x + 3] = alpha;
    }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, FloatType);
  const bytes = await new EXRExporter().parse(texture, { type: FloatType, compression: NO_COMPRESSION });
  return new Blob([bytes], { type: EXR_MIME });
}
