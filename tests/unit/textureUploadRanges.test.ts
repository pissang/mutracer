import {expect, it, vi} from 'vitest';
import {Texture2D} from '../../src/renderer/webgl';

it('uploads overlapping and adjacent covering rows once, retaining gaps between distant rows', () => {
  const data = new Float32Array(256), texture = new Texture2D({source: {width: 4, height: 16, data: data.slice()}});
  const upload = vi.spyOn(texture, 'updateDataRange').mockImplementation(() => {}), gl = {} as WebGL2RenderingContext;
  // Four RGBA float texels per row = 64 bytes. Input is intentionally unordered.
  texture.updateDataRanges(gl, data, [{offset: 256, size: 4}, {offset: 48, size: 32}, {offset: 0, size: 4}, {offset: 64, size: 16}]);
  expect(upload.mock.calls.map(([, , offset, size]) => [offset, size])).toEqual([[0, 80], [256, 4]]);
  upload.mockClear(); texture.updateDataRanges(gl, data, []); expect(upload).not.toHaveBeenCalled();
});

it('rejects an invalid range before uploading any earlier valid range', () => {
  const data = new Float32Array(64), texture = new Texture2D({source: {width: 4, height: 4, data}});
  const upload = vi.spyOn(texture, 'updateDataRange').mockImplementation(() => {}), gl = {} as WebGL2RenderingContext;
  for (const range of [{offset: 0, size: -4}, {offset: 255, size: 4}, {offset: 0, size: 260}, {offset: -4, size: 4}]) {
    expect(() => texture.updateDataRanges(gl, data, [{offset: 0, size: 4}, range])).toThrow(RangeError);
    expect(upload).not.toHaveBeenCalled();
  }
});
