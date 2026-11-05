/** Payload bytes of the uncompressed render-target formats used by MuTracer. */
export function textureBytes(texture: GPUTexture | undefined): number {
  if (!texture) return 0;
  const bytes = texture.format === 'rgba32float' ? 16 :
    texture.format === 'rgba16float' || texture.format === 'rg32float' ? 8 :
    texture.format === 'r32float' ? 4 : 4;
  return texture.width * texture.height * texture.depthOrArrayLayers * bytes;
}
