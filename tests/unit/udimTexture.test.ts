import {describe, expect, it} from 'vitest';
import UdimTexture, {udimTileFromUv, udimTileNumber} from '../../src/scene/UdimTexture';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import MaterialData from '../../src/renderer/MaterialData';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector';
import Mesh from '../../src/scene/Mesh';
import {createCubeGeometry} from '../../src/main';
import type {TextureDataSource} from '../../src/scene/Texture';

const rgba = (width: number, height: number, values: number[]) => ({width, height, data: new Uint8Array(values)});
const solid = (width: number, height: number, color: number[]) => rgba(width, height, Array(width * height).fill(color).flat());

describe('UdimTexture', () => {
  it('maps integer UV cells to the standard tile number and rejects the domain boundary', () => {
    expect(udimTileNumber(0, 0)).toBe(1001);
    expect(udimTileNumber(9, 4)).toBe(1050);
    expect(udimTileFromUv(1.9, 2.1)).toBe(1022);
    expect(udimTileFromUv(-0.01, 0)).toBeUndefined();
    expect(udimTileFromUv(10, 0)).toBeUndefined();
  });

  it('resamples inconsistent sizes, promotes mixed data and leaves missing tiles transparent', () => {
    const texture = new UdimTexture([
      {udim: 1001, image: solid(1, 1, [255, 0, 0, 255])},
      {udim: 1002, image: {width: 2, height: 1, data: new Float32Array([0, 1, 0, 1, 0, 0, 1, 1])}}
    ]);
    const image = texture.image as TextureDataSource;
    expect(image).toMatchObject({width: 20, height: 10});
    expect(image.data).toBeInstanceOf(Float32Array);
    expect([...image.data.slice(0, 4)]).toEqual([1, 0, 0, 1]);
    expect([...image.data.slice(8, 12)]).toEqual([0, 1, 0, 1]);
    expect([...image.data.slice(16, 20)]).toEqual([0, 0, 0, 0]);
  });

  it('rejects duplicate, invalid and malformed tiles', () => {
    expect(() => new UdimTexture([])).toThrow('at least one');
    expect(() => new UdimTexture([{udim: 1000, image: solid(1, 1, [0, 0, 0, 0])}])).toThrow('1001');
    expect(() => new UdimTexture([{udim: 1001, image: solid(1, 1, [0, 0, 0, 0])}, {udim: 1001, image: solid(1, 1, [0, 0, 0, 0])}])).toThrow('unique');
    expect(() => new UdimTexture([{udim: 1001, image: rgba(2, 1, [0, 0, 0, 0])}])).toThrow('RGBA');
  });

  it('packs a marker without changing ordinary texture layout or budget rules', () => {
    const map = new UdimTexture([{udim: 1001, image: solid(2, 2, [255, 255, 255, 255])}]);
    const material = new OpenPBRMaterial({map});
    const data = new MaterialData([material], [], () => 0, {maxTextureArrayBytes: 400, maxTextureDimension2D: 100}, () => false);
    expect(data.bufferData.mapColorLinear).toEqual([2]);
    expect(data.atlas.stats.estimatedBytes).toBeLessThanOrEqual(400);
    expect(data.atlas.stats.scale).toBeLessThan(1);
  });

  it('classifies replacing a UDIM reference like replacing an ordinary texture', () => {
    const make = () => new UdimTexture([{udim: 1001, image: solid(1, 1, [255, 255, 255, 255])}]);
    const material = new OpenPBRMaterial({map: make()});
    const snapshot = new SceneChangeDetector();
    const scene = {meshes: [new Mesh(createCubeGeometry(), material)], lights: []};
    snapshot.detect(scene); snapshot.commit(); material.map = make();
    expect(snapshot.detect(scene).materials).toContain(material);
  });
});
