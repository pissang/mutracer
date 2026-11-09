import {describe,it,expect} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import MaterialGraph from '../../src/scene/MaterialGraph';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader';
import {gpu,original} from './shaderSourceFormattingFixture';
describe('MaterialX HSV adjustment',()=>{
 it.each(['color3','color4'] as const)('uses hue addition and saturation/value multiplication for %s',type=>{
  for(const [amount,want] of [[[1/3,1,1],[0,1,0]],[[-1/3,1,1],[0,0,1]],[[0,0,.5],[.5,.5,.5]],[[2,1,2],[2,0,0]]] as const){
   const alpha=type==='color4'?[.37]:[],graph=normalizeGraph(new MaterialGraph({nodes:[{id:'a',category:'hsvadjust',type,inputs:{in:{type,value:[1,0,0,...alpha]},amount:{type:'vector3',value:amount}}},{id:'out',category:'convert',type:'color3',inputs:{in:{type,connection:{node:'a'}}}}],terminal:{baseColor:{node:'out'}}}));
   expect(graph.diagnostics).toEqual([]);const rgb=evaluateGraph(graph).baseColor;rgb.forEach((x,i)=>expect(x).toBeCloseTo(want[i],6));
  }
 });
 it.each(['rgbtohsv','hsvtorgb','hsvadjust'])('retains alpha, including alpha larger than RGB, through %s',category=>{
  const g=normalizeGraph(new MaterialGraph({nodes:[{id:'n',category,type:'color4',inputs:{in:{type:'color4',value:[.2,.4,.6,3]}}},{id:'a',category:'extract',type:'float',inputs:{in:{type:'color4',connection:{node:'n'}},index:{type:'integer',value:3}}}],terminal:{opacity:{node:'a'}}}));
  expect(g.diagnostics).toEqual([]);expect(evaluateGraph(g).opacity).toEqual([3]);
 });
 it('excludes alpha from the RGB extrema used by color4 HSV conversion',()=>{
  const g=normalizeGraph(new MaterialGraph({nodes:[{id:'h',category:'rgbtohsv',type:'color4',inputs:{in:{type:'color4',value:[.2,.4,.6,3]}}},{id:'rgb',category:'convert',type:'color3',inputs:{in:{type:'color4',connection:{node:'h'}}}}],terminal:{baseColor:{node:'rgb'}}}));
  expect(evaluateGraph(g).baseColor).toEqual([expect.closeTo(7/12,12),expect.closeTo(2/3,12),.6]);
 });
 it('generates valid varying WGSL for both color types and HSV conversion variants',()=>{
  gpu();
  for(const type of ['color3','color4'] as const)for(const category of ['rgbtohsv','hsvtorgb','hsvadjust']){
   const g=normalizeGraph(new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'c',category:'convert',type,inputs:{in:{type:'vector2',connection:{node:'uv'}}}},{id:'n',category,type,inputs:{in:{type,connection:{node:'c'}}}},{id:'out',category:'convert',type:'color3',inputs:{in:{type,connection:{node:'n'}}}}],terminal:{baseColor:{node:'out'}}}));
   expect(g.diagnostics).toEqual([]);
   const trace=original('src/renderer/wgsl/rayTrace.compute.ts').default({hasDisplacement:false,hasAnisotropyDirections:true,hasCoatNormals:true,hasAlpha:false});
   const source=materialGraphShader(trace,{key:g.key,graphs:[g],structures:[g]});
   expect(()=>makeShaderDataDefinitions(source)).not.toThrow();
  }
 });
});
