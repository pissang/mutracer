import {describe,it,expect} from 'vitest';
import {parseMaterialXGraph,pruneInactiveInputs} from '../src/engine/materialxGraph';
import {MaterialGraph} from '@meimu/mutracer';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate';
const doc=(node:string,version='1.38')=>`<materialx version="${version}">${node}<open_pbr_surface name="S" type="surfaceshader"><input name="geometry_normal" type="vector3" nodename="N"/></open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>`;
const normal=(space:string,extra='')=>`<normalmap name="N" type="vector3"><input name="in" type="vector3" value="1,0.5,1"/><input name="space" type="string" value="${space}"/>${extra}</normalmap>`;
describe('MaterialX 1.38 normalmap upgrade',()=>{
 it('removes tangent space and preserves normal mapping',()=>{
  const m=parseMaterialXGraph(doc(normal('tangent')));
  expect(m.warnings).toEqual([]);expect(evaluateGraph(normalizeGraph(m.graph!)).normal).toEqual([expect.closeTo(Math.SQRT1_2,12),0,expect.closeTo(Math.SQRT1_2,12)]);
 });
 it('decodes object normals as the official normalize(2*in-1) graph',()=>{
  const m=parseMaterialXGraph(doc(normal('object','<input name="scale" type="float" value="8"/>')));
  const g=normalizeGraph(m.graph!);expect(g.diagnostics).toEqual([]);
  expect(evaluateGraph(g,{normal:[0,1,0],tangent:[0,0,1]}).normal).toEqual([expect.closeTo(Math.SQRT1_2,12),0,expect.closeTo(Math.SQRT1_2,12)]);
 });
 it('derives an explicit bitangent from authored normal and tangent',()=>{
  const m=parseMaterialXGraph(doc(normal('tangent','<input name="normal" type="vector3" value="0,1,0"/><input name="tangent" type="vector3" value="1,0,0"/>').replace('1,0.5,1','0.5,1,1')));
  expect(m.warnings).toEqual([]);expect(evaluateGraph(normalizeGraph(m.graph!)).normal).toEqual([0,expect.closeTo(Math.SQRT1_2,12),expect.closeTo(-Math.SQRT1_2,12)]);
 });
 it('upgrades restored graphs once and keeps 1.39 unknown inputs diagnosed',()=>{
  const nodes=[{id:'N',category:'normalmap',type:'vector3' as const,inputs:{space:{type:'string' as const,value:'object'},in:{type:'vector3' as const,value:[1,.5,1]}}}];
  const once=pruneInactiveInputs(nodes,{normal:{node:'N'}}),twice=pruneInactiveInputs(once.nodes,once.terminal);
  expect(twice).toEqual(once);expect(normalizeGraph(new MaterialGraph(once)).diagnostics).toEqual([]);
  expect(parseMaterialXGraph(doc(normal('tangent'),'1.39')).warnings).toContainEqual(expect.stringContaining('space'));
 });
});
