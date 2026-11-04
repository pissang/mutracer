import {expect, it} from 'vitest';
import Texture from '../../src/scene/Texture.js';
import {planTextureAtlas} from '../../src/renderer/textureAtlas.js';
import {defaultSceneConfiguration} from '../../native/src/scene-configuration.js';
import {planIndependentTextures} from '../../src/renderer/WGPUBindlessTextures.js';

function textures(sizes: number[][]) {
  return sizes.map(([width, height]) => new Texture({width, height} as HTMLImageElement));
}
it('keeps large native image sets under the configurable native budget', () => {
  const images = textures(Array.from({length: 40}, () => [2048, 2048]));
  const budget = defaultSceneConfiguration().textureBudgetBytes;
  expect(budget).toBe(3 * 1024 * 1024 * 1024);
  const native = planTextureAtlas(images, images.map(() => 0), {independentTextures: true, maxTextureArrayBytes: budget, maxTextureDimension2D: 16384});
  const web = planIndependentTextures(images, budget, 16384);
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

it.each([false, true])('charges shared images once while retaining logical samplers (float=%s)', float => {
  const source = {width: 32, height: 16, data: new Uint8Array(32 * 16 * 4)};
  const a = new Texture(source), b = new Texture(source), c = new Texture({width: 8, height: 8, data: new Uint8Array(8 * 8 * 4)});
  a.flipY = b.flipY = c.flipY = false;
  b.uvScale = [2, 3]; b.uvChannel = 1; b.wrapS = 'clamp-to-edge';
  const bytes = (32 * 16 + 8 * 8) * (float ? 8 : 4);
  const plan = planTextureAtlas([a, b, c], [0, Number(float), 0], {independentTextures: true, maxTextureArrayBytes: bytes});
  expect(plan.stats.scale).toBe(1);
  expect(plan.stats.estimatedBytes).toBe(bytes);
  expect(plan.pages).toHaveLength(2);
  expect(plan.mapInfo).toEqual([32,16,0,0, 32,16,0,0, 8,8,1,0]);
  expect(plan.mapTransform.slice(4, 8)).toEqual([2,3,0,0]);
  expect(plan.mapUvChannel).toEqual([0,1,0]);
  expect(plan.mapWrap.slice(2, 4)).toEqual([1,0]);
  b.flipY = true;
  const flipped = planTextureAtlas([a, b, c], [0, Number(float), 0], {independentTextures: true, maxTextureArrayBytes: bytes});
  expect(flipped.pages).toHaveLength(3);
  expect(flipped.stats.scale).toBeLessThan(1);
  expect(flipped.stats.estimatedBytes).toBeLessThanOrEqual(bytes);
});
