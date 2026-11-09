import {describe,it,expect} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Mesh from '../../src/scene/Mesh.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
const constant=(id:string,value:number)=>({id,category:'constant',type:'float' as const,inputs:{value:{type:'float' as const,value}}});
describe('MaterialGraph',()=>{
 it('separates parameters and canonical reachable structure',()=>{
  const a=new MaterialGraph({nodes:[constant('a',0.2),constant('dead',0.7)],terminal:{specularRoughness:{node:'a'}}});
  const b=new MaterialGraph({nodes:[constant('renamed',0.8)],terminal:{specularRoughness:{node:'renamed'}}});
  const an=normalizeGraph(a),bn=normalizeGraph(b);
  expect(an.diagnostics).toEqual([]);expect(an.nodes).toHaveLength(1);expect(an.key).toBe(bn.key);expect(an.parameters).not.toEqual(bn.parameters);
  expect(normalizeGraph(a,'bindless').key).not.toBe(an.key);
 });
 it('normalizes author order and locates invalid edges',()=>{
  const nodes=[constant('a',0.2),{id:'b',category:'multiply',type:'float' as const,inputs:{in1:{type:'float' as const,connection:{node:'a'}},in2:{type:'float' as const,value:2}}}];
  const a=new MaterialGraph({nodes,terminal:{specularRoughness:{node:'b'}}});
  expect(normalizeGraph(a).key).toBe(normalizeGraph(new MaterialGraph({nodes:[...nodes].reverse(),terminal:a.terminal})).key);
  a.setInput('b','in1',{type:'float',connection:{node:'b'}});
  expect(normalizeGraph(a).diagnostics).toContainEqual(expect.objectContaining({code:'cycle',node:'b'}));
 });
 it('reports unsupported graphs and type mismatches without dropping terminal connections',()=>{
  const graph=new MaterialGraph({nodes:[{id:'bad',category:'unknown_node',type:'float'}],terminal:{baseColor:{node:'bad'}}});
  expect(normalizeGraph(graph).diagnostics.map(d=>d.code)).toEqual(['unsupported-node','terminal-type']);
 });
 it('commits graph edits as incremental material changes',()=>{
  const graph=new MaterialGraph({nodes:[constant('c',0.2)],terminal:{specularRoughness:{node:'c'}}});
  const material=new OpenPBRMaterial({graph}), mesh=new Mesh(createPlaneGeometry(),material), scene={meshes:[mesh],lights:[]};
  const detector=new SceneChangeDetector();detector.detect(scene);detector.commit();
  graph.setInput('c','value',{type:'float',value:0.7});const change=detector.detect(scene);
  expect(change.meshes).toBe('incremental');expect(change.materials).toEqual([material]);
 });
 it('retains immutable input values and advances edit revisions',()=>{
  const value=[1,0,0]; const graph=new MaterialGraph({nodes:[{id:'c',category:'constant',type:'color3',inputs:{value:{type:'color3',value}}}],terminal:{baseColor:{node:'c'}}});
  value[0]=0; expect(graph.nodes[0].inputs?.value.value).toEqual([1,0,0]);
  graph.setInput('c','value',{type:'color3',value:[0,1,0]});expect(graph.revision).toBe(1);
  const material=new OpenPBRMaterial({graph});expect(material.graph).toBe(graph);
 });
});
