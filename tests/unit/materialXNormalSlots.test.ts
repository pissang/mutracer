import {describe,it,expect} from 'vitest';
import Texture from '../../src/scene/Texture.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import MaterialData from '../../src/renderer/MaterialData.js';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
import Mesh from '../../src/scene/Mesh.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass.js';
import {causticLightCompute} from '../../src/renderer/wgsl/causticLight.compute.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {original,stripped,tokens,gpu} from './shaderSourceFormattingFixture';

describe('MaterialX normal texture slots',()=>{
 it('tags the normal reference without changing any other material or texture indices',()=>{
  const texture=new Texture({width:1,height:1,data:new Float32Array([.5,.5,1,1])});
  const material=new OpenPBRMaterial({normalMap:texture,map:texture});
  const base=new MaterialData([material],[],()=>1);expect(base.bufferData.normalMapIndex).toEqual([0]);expect(base.bufferData.diffuseMapIndex).toEqual([0]);
  texture.normalMapFrame='materialx';const mx=new MaterialData([material],[],()=>1);expect(mx.bufferData.normalMapIndex).toEqual([.5]);expect(mx.bufferData.diffuseMapIndex).toEqual([0]);
  mx.repackTextureReferences([material]);expect(mx.bufferData.normalMapIndex).toEqual([.5]);texture.normalMapFrame='cotangent';mx.repackTextureReferences([material]);expect(mx.bufferData.normalMapIndex).toEqual([0]);
 });
 it('detects frame edits on an existing texture',()=>{
  const texture=new Texture({width:1,height:1,data:new Float32Array([.5,.5,1,1])}),material=new OpenPBRMaterial({normalMap:texture});
  const detector=new SceneChangeDetector(),scene={meshes:[new Mesh(createPlaneGeometry(),material)],lights:[]};
  detector.detect(scene);detector.commit();const tracker=new MaterialChangeTracker();tracker.capture([material]);
  expect(detector.detect(scene).materials).toEqual([]);texture.normalMapFrame='materialx';expect(detector.detect(scene).materials).toEqual([material]);
  expect(tracker.classify([material]).level).toBe('textures');
 });
 it('retires the optional shader specialization after the last MaterialX map is removed',()=>{
  const material=new OpenPBRMaterial(),data=new MaterialData([material],[],()=>1);
  const receiver={_constants:{NUM_MAPS:20,USE_MATERIALX_NORMAL_MAPS:true},_bevelSamples:1};
  (WGPURayTracePass.prototype as any)._updateMaterialConstants.call(receiver,[material],{...data,getDisplacementMaps:()=>[]},createPlaneGeometry());
  expect(receiver._constants).not.toHaveProperty('USE_MATERIALX_NORMAL_MAPS');
 });
 it.each(['lightTracing','photonMapping'] as const)('specializes the %s emitter without a separate material layout',mode=>{
  gpu();const source=causticLightCompute({NUM_MAPS:1,NUM_UNIFORM_LIGHTS:1,TLAS_STACK_SIZE:8,BLAS_STACK_SIZE:32,USE_ANISOTROPY_DIRECTIONS:true,USE_COAT_NORMAL_FRAMES:true},1,false,mode,'',true,false,false,false,false,{materialXNormals:true});
  expect(makeShaderDataDefinitions(source).entryPoints.main).toBeDefined();
 });
 it.each([false,true])('specializes compressed shaders and composes with graphs (compact=%s)',compactVertices=>{
  gpu();const options={hasDisplacement:false,hasAnisotropyDirections:true,hasCoatNormals:true,hasAlpha:true,hasSceneAlpha:true,compactVertices};
  const shader=(loader:typeof original)=>loader('src/renderer/wgsl/rayTrace.compute.ts').default({...options,materialHooks:{materialXNormals:true}});
  const full=shader(original),compact=shader(stripped);expect(tokens(compact)).toEqual(tokens(full));expect(makeShaderDataDefinitions(compact).entryPoints.main).toBeDefined();
  const graph=normalizeGraph(new MaterialGraph({nodes:[{id:'n',category:'normalmap',type:'vector3'}],terminal:{normal:{node:'n'}}}));
  expect(makeShaderDataDefinitions(stripped('src/renderer/wgsl/rayTrace.compute.ts').default({...options,materialHooks:{...materialGraphShader({key:graph.key,graphs:[graph],structures:[graph]}),materialXNormals:true}})).entryPoints.main).toBeDefined();
 });
});
