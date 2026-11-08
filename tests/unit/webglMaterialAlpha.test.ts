import {describe, expect, it, vi} from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import type Geometry from '../../src/scene/Geometry';
import {createSphereGeometry} from '../../src/util/commonGeometry';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state';

// Exercise the pass's actual specialization boundary without a GPU context.
function updateConstants(materials: OpenPBRMaterial[]) {
  const setDefines = vi.fn();
  const receiver = {graphs:new MaterialGraphState('webgl'), _tracePasses: [{setDefines}], _bevelSamples: 4};
  const method = (WebGLRayTracePass.prototype as unknown as {
    _updateMaterialConstants: (materials: OpenPBRMaterial[], table: MaterialTable, geometry: Geometry) => void
  })._updateMaterialConstants;
  method.call(receiver, materials, {defines: {}, setToPass: vi.fn()} as unknown as MaterialTable, createSphereGeometry(4, 2));
  return setDefines.mock.calls[0][0].HAS_ALPHA;
}

describe('WebGL material alpha specialization', () => {
  const alphaMap = new Texture({width: 1, height: 1, data: new Float32Array([1, 0.4, 1, 1])});
  it.each([
    [{}, false],
    [{opacity: 0.4}, true],
    [{mapAlphaUsage: 'alpha' as const}, true],
    [{alphaMap}, true],
    [{alphaCutoff: 0.5}, true],
    [{alphaMode: 'mask' as const}, true],
    [{alphaMode: 'blend' as const}, true],
    [{alphaMode: 'opaque' as const, opacity: 0.4, alphaMap, alphaCutoff: 0.5, mapAlphaUsage: 'alpha' as const}, false]
  ])('selects HAS_ALPHA for resolved inputs %j', (params, expected) => {
    expect(updateConstants([new OpenPBRMaterial(params)])).toBe(expected);
    expect(updateConstants([new OpenPBRMaterial(), new OpenPBRMaterial(params)])).toBe(expected);
  });
});
