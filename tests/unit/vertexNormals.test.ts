import {expect, it} from 'vitest';
import {accumulateVertexNormals} from '../../src/util/vertexNormals.js';
import {generateVertexNormals} from '../../src/util/geometry.js';
import {computeGeometryNormals} from '../../src/renderer/scenePreparation.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';

// Vertex 0 is shared by a +Z triangle of area 2 and a -X triangle of area 1/2.
const positions = new Float32Array([0,0,0, 2,0,0, 0,2,0, 0,1,0, 0,0,-1]);
const indices = new Uint32Array([0,1,2, 0,3,4]);

it('weights shared vertices by triangle area and normalizes every sum', () => {
  const normals = accumulateVertexNormals(positions, indices, 5);
  const z = 2 / Math.hypot(2, 0.5), x = -0.5 / Math.hypot(2, 0.5);
  expect(normals[0]).toBeCloseTo(x, 6);
  expect(normals[1]).toBeCloseTo(0, 6);
  expect(normals[2]).toBeCloseTo(z, 6);
  expect(Array.from(normals.slice(3, 9))).toEqual([0,0,1, 0,0,1]);
  expect(Array.from(normals.slice(9))).toEqual([-1,0,0, -1,0,0]);
});

it('treats consecutive vertices as triangles without indices', () => {
  expect(Array.from(accumulateVertexNormals(positions.slice(0, 9), undefined, 3))).toEqual([0,0,1, 0,0,1, 0,0,1]);
});

it('gives the public helper and renderer preparation the same normals', () => {
  const helper = new Geometry({position: new Attribute(positions.slice(), 3), indices: new Attribute(new Uint16Array(indices), 1)});
  const renderer = new Geometry({position: new Attribute(positions.slice(), 3), indices: new Attribute(new Uint16Array(indices), 1)});
  generateVertexNormals(helper);
  computeGeometryNormals(renderer);
  expect(renderer.normal.array).toEqual(helper.normal.array);
});
