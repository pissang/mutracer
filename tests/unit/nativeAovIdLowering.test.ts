import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import ts from 'typescript';
import {lowerMeshAovId} from '../../native/scripts/aov-id-lowering.mjs';
import {validateAovId} from '../../src/renderer/aov.js';
import SceneNode from '../../src/scene/SceneNode.js';
import Geometry from '../../src/scene/Geometry.js';
import MaterialState from '../../src/scene/MaterialState.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';

const source = readFileSync(new URL('../../src/scene/MeshState.ts', import.meta.url), 'utf8');
function execute(source: string) {
  const exports: {default?: new(geometry:Geometry, material:MaterialState)=>{aovId:number}} = {};
  let next = 0;
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,
    target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports', 'require', code)(exports, (name:string) => {
    if (name === '../renderer/aov.js') return {allocateAovId:()=>next++, validateAovId};
    if (name === './SceneNode.js') return {default:SceneNode};
    throw new Error(`Unexpected runtime import ${name}`);
  });
  return exports.default!;
}
describe('native mesh AOV storage specialization', () => {
  it('preserves allocation, validated assignments and prototype-based mirrors', () => {
    const geometry = createPlaneGeometry(), material = new MaterialState();
    for (const text of [source, lowerMeshAovId(source)]) {
      const Mesh = execute(text), mesh = new Mesh(geometry, material);
      expect([mesh.aovId, new Mesh(geometry, material).aovId]).toEqual([0, 1]);
      for (const id of [0, 0x800001ff, 0xfffffffe]) {
        mesh.aovId = id;
        const mirror = Object.create(Object.getPrototypeOf(mesh));
        mirror.aovId = mesh.aovId;
        expect(mirror.aovId).toBe(id);
        for (const invalid of [-1, 1.5, NaN, Infinity, 0xffffffff, 0x100000000]) {
          expect(() => {mesh.aovId = invalid;}).toThrow(RangeError);
          expect(mesh.aovId).toBe(id);
        }
      }
    }
  });
  it('rejects changed storage contracts instead of silently emitting a different ID path', () => {
    expect(() => lowerMeshAovId(source.replace('aovIds.get(this)!', '0'))).toThrow('storage changed');
  });
});
