import {afterEach, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {compactVertexLayout, packCompactVertices} from '../../src/renderer/compactVertices';
import {packWgpuVertexLayout} from '../../src/renderer/wgpuVertexLayout';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';
import rayTraceCore from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {Attribute} from '../../src/scene/Geometry';

afterEach(() => {vi.unstubAllGlobals();});

it('matches the extended editing uniform to the shader without changing the default host contract', () => {
  vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
  for (const runtimeVertexLayout of [false, true]) {
    const {buffer, views, vertexLayout} = makeRayTraceUniform(runtimeVertexLayout);
    const parsed = makeShaderDataDefinitions(rayTraceCore({compactVertices: true, runtimeVertexLayout}));
    const layout = parsed.structs.RayTraceUniform;
    expect(layout.size).toBe(buffer.byteLength);
    for (const [name, view] of Object.entries(views)) expect(layout.fields[name].offset, name).toBe(view.byteOffset);
    if (runtimeVertexLayout) {
      expect(layout.fields.vertexLayout0.offset).toBe(vertexLayout!.byteOffset);
      expect(layout.fields.vertexLayout1.offset).toBe(vertexLayout!.byteOffset + 16);
      expect(vertexLayout!.byteLength).toBe(32);
    } else expect(vertexLayout).toBeUndefined();
  }
});

it('addresses packed attributes after tangent, secondary-UV, color and normal-format changes', () => {
  const geometry = createCubeGeometry(), {vertexLayout} = makeRayTraceUniform(true);
  for (const expanded of [false, true]) {
    if (expanded) {
      geometry.tangent = new Attribute(new Float32Array(geometry.vertexCount * 4).fill(1), 4);
      geometry.uv1 = new Attribute(new Float32Array(geometry.vertexCount * 2).fill(.125), 2);
      geometry.color = new Attribute(new Float32Array(geometry.vertexCount * 3).fill(2), 3);
    }
    const layout = compactVertexLayout([geometry], expanded);
    layout.constants.MATERIALINDEX_OFF = geometry.vertexCount * layout.stride;
    packWgpuVertexLayout(layout.constants, vertexLayout!);
    const packed = new Uint32Array(geometry.vertexCount * layout.stride);
    packCompactVertices(geometry, packed, layout.stride, layout.offsets, 0, geometry.vertexCount, 0, false, expanded, expanded);
    const floats = new Float32Array(packed.buffer), u = vertexLayout!;
    expect(u[0]).toBe(layout.stride);
    expect(Array.from(u.slice(1, 6))).toEqual(layout.offsets.slice(1, 6));
    expect(u[6]).toBe(packed.length);
    expect(!!(u[7] & 2)).toBe(expanded);
    expect(!!(u[7] & 16)).toBe(expanded);
    for (const vertex of [0, geometry.vertexCount - 1]) {
      const base = vertex * u[0];
      expect(floats.slice(base + u[2], base + u[2] + 2)).toEqual(geometry.uv!.array.slice(vertex * 2, vertex * 2 + 2));
      if (expanded) {
        expect(floats.slice(base + u[1], base + u[1] + 3)).toEqual(geometry.normal.array.slice(vertex * 3, vertex * 3 + 3));
        expect(floats[base + u[3]]).toBe(.125);
        expect(floats[base + u[4]]).toBe(2);
      }
    }
  }
});
