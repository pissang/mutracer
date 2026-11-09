import {describe,it,expect} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Geometry, {Attribute as GeometryAttribute} from '../../src/scene/Geometry.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import {materialGraphConstants} from '../../src/renderer/materialGraph/features.js';
const base={USE_ANISOTROPY_DIRECTIONS:false,USE_COAT_NORMAL_FRAMES:false,USE_TANGENT:false,USE_UV1:false,HAS_COAT:false,HAS_FUZZ:false,HAS_THIN_FILM:false,HAS_ALPHA:false,MATERIAL_CAPABILITIES:0};
function scene(terminal:string,category='constant',type:'float'|'vector3'='float'){
 const m=new OpenPBRMaterial({graph:new MaterialGraph({nodes:[{id:'n',category,type}],terminal:{[terminal]:{node:'n'}}})});
 const s=new MaterialGraphState();s.request([m]);return {m,plan:s.requested};
}
describe('graph shader capabilities',()=>{
 it('preserves every no-graph constant',()=>{
  const s=new MaterialGraphState();s.request([new OpenPBRMaterial()]);expect(materialGraphConstants(base,s.requested)).toEqual(base);
 });
 it.each([['coatWeight','HAS_COAT'],['fuzzWeight','HAS_FUZZ'],['thinFilmWeight','HAS_THIN_FILM']])('enables %s without the other lobes', (terminal,flag)=>{
  const {plan}=scene(terminal);const actual=materialGraphConstants(base,plan);expect(actual[flag]).toBe(true);
  for(const other of ['HAS_COAT','HAS_FUZZ','HAS_THIN_FILM'].filter(x=>x!==flag))expect(actual[other]).toBe(false);
  expect(actual.USE_ANISOTROPY_DIRECTIONS).toBe(false);
 });
 it('keeps frames for normal and anisotropy terminals, including zero-valued parameters',()=>{
  for(const [terminal,category,type] of [['normal','normalmap','vector3'],['specularAnisotropy','constant','float'],['coatAnisotropy','constant','float']] as const){
   const {plan}=scene(terminal,category,type);expect(materialGraphConstants(base,plan).USE_ANISOTROPY_DIRECTIONS).toBe(true);
  }
 });
 it('keeps a graph material’s constant anisotropy frame through edits',()=>{
  const {m,plan}=scene('specularRoughness');expect(materialGraphConstants(base,plan).USE_ANISOTROPY_DIRECTIONS).toBe(false);
  m.coatAnisotropy=.5;expect(materialGraphConstants(base,plan).USE_ANISOTROPY_DIRECTIONS).toBe(true);
 });
 it('retains UV1 for an editable texcoord selector but not for an implicit UV0 image',()=>{
  const geometry=new Geometry({position:new GeometryAttribute(new Float32Array(9),3)});geometry.uv1=new GeometryAttribute(new Float32Array(6),2);
  const graph=new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'c',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{baseColor:{node:'c'}}});
  const s=new MaterialGraphState();s.request([new OpenPBRMaterial({graph})]);expect(materialGraphConstants(base,s.requested,geometry).USE_UV1).toBe(true);
  const image=new MaterialGraph({nodes:[{id:'i',category:'image',type:'color3'}],terminal:{baseColor:{node:'i'}}});s.request([new OpenPBRMaterial({graph:image})]);expect(materialGraphConstants(base,s.requested,geometry).USE_UV1).toBe(false);
 });
 it('selects transport and alpha support by terminal',()=>{
  expect(materialGraphConstants(base,scene('transmissionWeight').plan).MATERIAL_CAPABILITIES).toBe(1);
  expect(materialGraphConstants(base,scene('baseMetalness').plan).MATERIAL_CAPABILITIES).toBe(2);
  expect(materialGraphConstants(base,scene('opacity').plan)).toMatchObject({HAS_ALPHA:true,HAS_ALPHA_BLEND:true,HAS_ALPHA_MASK:true});
 });
});
