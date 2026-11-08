import {describe,it,expect} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {original,stripped,tokens,gpu} from './shaderSourceFormattingFixture';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';

describe('material graphs in production shader builds',()=>{
 it.each([false,true])('preserves surface, normal and shadow evaluation after compression (compact vertices=%s)',compactVertices=>{
  gpu();
  const graph=normalizeGraph(new MaterialGraph({nodes:[
   {id:'uv',category:'texcoord',type:'vector2'},
   {id:'a',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}},
   {id:'noise',category:'noise2d',type:'color3'},
   {id:'n',category:'normalmap',type:'vector3'}
  ],terminal:{baseColor:{node:'noise'},opacity:{node:'a'},normal:{node:'n'}}}));
  expect(graph.diagnostics).toEqual([]);
  const plan={key:graph.key,graphs:[graph],structures:[graph]};
  const options={hasDisplacement:false,hasAnisotropyDirections:true,hasCoatNormals:true,hasAlpha:true,hasSceneAlpha:true,compactVertices};
  for(const backend of ['webgpu','webgl'] as const){
   const path=backend==='webgpu'?'src/renderer/wgsl/rayTrace.compute.ts':'src/renderer/glsl/raytrace.frag.ts';
   const source=(loader:typeof original)=>{const value=loader(path).default(options);return backend==='webgpu'?value:value.main;};
   const full=materialGraphShader(source(original),plan,backend),compact=materialGraphShader(source(stripped),plan,backend);
   expect(tokens(compact)).toEqual(tokens(full));
   if(backend==='webgpu')expect(makeShaderDataDefinitions(compact).entryPoints.main).toBeDefined();
  }
 });
});
