import {expect, it} from 'vitest';
import {packedVertexChange} from '../../native/src/vertex-updates.js';
import {compactVertexLayout, packCompactVertices} from '../../src/renderer/compactVertices.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';

it('uploads complete changed vertex records and preserves surrounding packed bytes', () => {
  const previous = createPlaneGeometry(), next = new Geometry(previous);
  next.position = new Attribute(new Float32Array(previous.position.array), 3);
  next.position.array[3] += .1;
  const layout = compactVertexLayout([previous], false);
  const change = packedVertexChange(previous, next, layout.stride, layout.offsets, false, false);
  const pack = (g: Geometry) => {
    const data = new Uint32Array(g.vertexCount * layout.stride);
    packCompactVertices(g, data, layout.stride, layout.offsets, 0, g.vertexCount);
    return new Uint8Array(data.buffer);
  };
  const applied = pack(previous), expected = pack(next);
  expect(change.offset).toBe(layout.stride * 4);
  expect(change.data.byteLength).toBe(layout.stride * 4);
  applied.set(change.data, change.offset);
  expect(applied).toEqual(expected);
  expect(packedVertexChange(next, next, layout.stride, layout.offsets, false, false).data.length).toBe(0);
});
