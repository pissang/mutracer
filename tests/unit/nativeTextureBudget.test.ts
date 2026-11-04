import {expect, it} from 'vitest';
import Texture from '../../src/scene/Texture.js';
import {planTextureAtlas, DEFAULT_MAX_TEXTURE_ARRAY_BYTES} from '../../src/renderer/textureAtlas.js';
import {planIndependentTextures} from '../../src/renderer/WGPUBindlessTextures.js';

function textures(sizes: number[][]) {
  return sizes.map(([width, height]) => new Texture({width, height} as HTMLImageElement));
}
it('keeps original native images under the same default budget as web', () => {
  const images = textures(Array.from({length: 20}, () => [2048, 2048]));
  const native = planTextureAtlas(images, images.map(() => 0), {independentTextures: true, maxTextureDimension2D: 16384});
  const web = planIndependentTextures(images, DEFAULT_MAX_TEXTURE_ARRAY_BYTES, 16384);
  expect(native.stats.scale).toBe(1);
  expect(native.stats.estimatedBytes).toBe(web.estimatedBytes);
  expect(native.placements.map(({width, height}) => ({width, height}))).toEqual(web.sizes);
  expect(native.mapInfo.slice(0, 8)).toEqual([2048, 2048, 0, 0, 2048, 2048, 1, 0]);
});
it.each([false, true])('matches web uniform scaling and device limits (float=%s)', float => {
  const images = textures([[8192, 4096], [4096, 8192], [2048, 1024], [1, 32]]);
  if (float) for (const t of images) t.image = {width: t.image.width, height: t.image.height, data: new Float32Array(0)};
  const budget = 128 * 1024 * 1024;
  const native = planTextureAtlas(images, images.map(() => Number(float)), {independentTextures: true, maxTextureArrayBytes: budget, maxTextureDimension2D: 4096});
  const web = planIndependentTextures(images, budget, 4096);
  expect(native.placements.map(({width, height}) => ({width, height}))).toEqual(web.sizes);
  expect(native.stats.estimatedBytes).toBe(web.estimatedBytes);
  expect(native.stats.estimatedBytes).toBeLessThanOrEqual(budget);
});
