import {buildWebTLAS,tlasInstanceSlots,INSTANCE_WORD_STRIDE} from '../../src/renderer/bvhAccel.js';
import {updateMeshInstances} from '../../src/renderer/prepareMeshBVH.js';
import {graphContextDiagnostics} from '../../src/renderer/materialGraph/context.js';
import {flattenGraphUnchecked} from '../../src/renderer/materialGraph/flatten.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {GraphSource,graphGeometry} from '../../src/renderer/materialGraph/ir.js';
import {describe,it,expect} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import InstancedMesh from '../../src/scene/InstancedMesh.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import {materialLayoutFields,MATERIAL_FLOAT_COUNT} from '../../src/renderer/materialLayoutSchema.js';
import {colorLuminance,EmissiveTriangleCache,LightChoiceBuffer,packEmissiveTriangles} from '../../src/renderer/lightSampling.js';
import {prepareSceneLightSampling} from '../../src/renderer/sceneAssembly.js';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges.js';
const offset=materialLayoutFields().find(f=>f.name==='emission')!.offset/4;
function graph(category='texcoord') {
 const type=category==='texcoord'?'vector2':'vector3';
 return new MaterialGraph({nodes:[{id:'source',category,type},{id:'color',category:'convert',type:'color3',inputs:{in:{type,connection:{node:'source'}}}}],terminal:{emissionColor:{node:'color'}}});
}
function install(material:OpenPBRMaterial) {const state=new MaterialGraphState();state.request([material]);state.install(state.requested,state.revision);return state;}
describe('lit graph emission',()=>{
 it.each(['texcoord','position'])('accepts %s on lit emitters with a black fallback',category=>{
  const material=new OpenPBRMaterial({graph:graph(category),emissionColor:[0,0,0],emissionLuminance:0}),state=install(material);
  expect(state.diagnostics).toEqual([]);expect(state.active.graphs[0]).toBeDefined();
  expect(state.emissionProposal(material)).toEqual([1,1,1]);
  expect([...state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[]).slice(offset,offset+3)]).toEqual([1,1,1]);
 });
 it.each(['normal','tangent','bitangent','normalmap','transformnormal'])('rejects reachable %s at its node and terminal',category=>{
  const material=new OpenPBRMaterial({graph:graph(category)}),state=install(material);
  expect(state.diagnostics).toContainEqual(expect.objectContaining({code:'unsupported-emission-graph',node:'source',port:'emissionColor'}));
  expect(state.active.graphs[0]).toBeUndefined();expect(state.emissionProposal(material)).toBeUndefined();
 });
 it('allows frame-dependent branches that do not feed emission',()=>{
  const g=graph();g.setNode({id:'normal',category:'normalmap',type:'vector3'}).setTerminal({emissionColor:{node:'color'},normal:{node:'normal'}});
  expect(install(new OpenPBRMaterial({graph:g})).diagnostics).toEqual([]);
 });
 it('rejects implicit shading-frame inputs and projected UV emission',()=>{
  const ir=flattenGraphUnchecked(normalizeGraph(new MaterialGraph({nodes:[{id:'source',category:'convert',type:'color3',inputs:{in:{type:'vector3',value:[0,0,1]}}}],terminal:{emissionColor:{node:'source'}}})));
  ir.inputs[2]=GraphSource.Geometry;ir.inputs[3]=graphGeometry.indexOf('normal');
  expect(graphContextDiagnostics(ir,false,false,true,false,true)[0]).toMatchObject({node:0,code:'unsupported-emission-graph'});
  expect(install(new OpenPBRMaterial({graph:graph(),uvProjection:'triplanar'})).diagnostics[0]).toMatchObject({port:'emissionColor',code:'unsupported-emission-graph'});
  expect(install(new OpenPBRMaterial({graph:graph('position'),uvProjection:'triplanar'})).diagnostics).toEqual([]);
 });
 it('validates coat dependencies when emission is graphed or constant',()=>{
  for(const emission of [false,true]) {
   const g=graph('normal');g.setTerminal(emission?{emissionColor:{node:'color'},coatColor:{node:'color'}}:{coatColor:{node:'color'}});
   const material=new OpenPBRMaterial({graph:g,emissionLuminance:emission?0:2});
   expect(install(material).diagnostics).toContainEqual(expect.objectContaining({code:'unsupported-emission-graph',port:'coatColor',node:'source'}));
  }
  const g=graph('normal');g.setTerminal({coatColor:{node:'color'}});
  expect(install(new OpenPBRMaterial({graph:g})).diagnostics).toEqual([]);
 });
 it('keeps unlit contexts unrestricted and outside light proposals',()=>{
  const material=new OpenPBRMaterial({graph:graph('normal'),unlit:true,emissionLuminance:4}),state=install(material);
  expect(state.diagnostics).toEqual([]);expect(state.emissionProposal(material)).toBeUndefined();
 });
 it('uses the same uncoated fallback RGB for CPU selection and packed hit MIS',()=>{
  const material=new OpenPBRMaterial({graph:graph(),emissionColor:[2,.4,.1],emissionLuminance:3,coatColor:[0,0,0],coatWeight:1}),state=new MaterialGraphState();
  state.request([material]);expect(state.emissionProposal(material)).toBeUndefined();state.install(state.requested,state.revision);
  const packed=state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[]),proposal=state.emissionProposal(material)!;
  expect(proposal).toEqual([6,1.2000000000000002,.30000000000000004]);
  expect(colorLuminance(packed.slice(offset,offset+3))).toBeCloseTo(colorLuminance(proposal),6);
  state.emissionSampling=false;expect(state.emissionProposal(material)).toBeUndefined();
  expect([...state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[]).slice(offset,offset+3)]).toEqual([0,0,0]);
 });
 it('refreshes emitter activity on graph edits and removal',()=>{
  const material=new OpenPBRMaterial({graph:graph()}),tracker=new MaterialChangeTracker(),state=install(material);
  tracker.capture([material]);material.graph!.setInput('source','index',{type:'integer',value:1});
  expect(tracker.classify([material]).emission).toBe(true);tracker.capture([material]);material.graph=undefined;
  expect(tracker.classify([material]).emission).toBe(true);state.request([material]);state.install(state.requested,state.revision);expect(state.emissionProposal(material)).toBeUndefined();
 });
 it('maps reordered TLAS leaves to the transforms used at surface hits',()=>{
  const mesh=new InstancedMesh(createPlaneGeometry(),new OpenPBRMaterial({emissionLuminance:2}),{count:8});
  for(let i=0;i<8;i++)mesh.transforms[i*16+12]=(7-i)*3;
  const prepared=updateMeshInstances([mesh]),tlas=buildWebTLAS(prepared.instances,prepared.blases),slots=tlasInstanceSlots(tlas);
  const records=new Float32Array(tlas.instancesBuffer!);
  expect(slots.size).toBe(8);expect([...slots].some(([source,target])=>source!==target)).toBe(true);
  for(const [source,target] of slots)expect(records[target*INSTANCE_WORD_STRIDE+20+12]).toBe(mesh.transforms[source*16+12]);
 });
 it('packs browser instance slots without changing the six-texel fallback layout',()=>{
  const material=new OpenPBRMaterial({emissionLuminance:2}),mesh=new InstancedMesh(createPlaneGeometry(),material,{count:2});
  const binding={mesh,geometry:mesh.geometry,materialIndices:[0],instanceSlots:[5,9]},cache=new EmissiveTriangleCache();
  let triangles=cache.collect([binding],[material]);expect(triangles.map(t=>t.instanceIndex)).toEqual([5,5,9,9]);
  const legacy=packEmissiveTriangles(triangles),browser=packEmissiveTriangles(triangles,undefined,true);
  expect(legacy.length).toBe(4*24);expect(browser.length).toBe(4*28);
  for(let i=0;i<4;i++) {expect(browser.slice(i*28,i*28+24)).toEqual(legacy.slice(i*24,i*24+24));expect(browser[i*28+24]).toBe(i<2?5:9);}
  const choices=new LightChoiceBuffer(),lighting=prepareSceneLightSampling([],triangles,0,4096,choices,undefined,undefined,true);
  expect(lighting.emissiveTexels).toBe(28);expect(lighting.lightData[24]).toBe(5);expect(lighting.lightData[52]).toBe(5);expect(lighting.choiceCount).toBe(4);
  binding.instanceSlots=[3,-1];triangles=cache.collect([binding],[material]);expect(triangles.map(t=>t.instanceIndex)).toEqual([3,3]);
 });
});
