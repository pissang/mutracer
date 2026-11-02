import {afterEach, expect, it} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {casterDirectionPdf, type CasterSphere} from '../../src/renderer/caustics';
import {packCausticLightUniform} from '../../src/renderer/causticUniform';
import {causticLightCompute} from '../../src/renderer/wgsl/causticLight.compute';
import {photonLayout} from '../../src/renderer/wgsl/photonMap.compute';
import rayTrace from '../../src/renderer/wgsl/rayTrace.compute';
import {gpu} from './shaderSourceFormattingFixture';
import {causticDiagnostics as d} from '../../src/renderer/causticDiagnostics';
afterEach(() => {delete d.photonPerCasterRadius;delete d.causticViewImportance;delete d.photonDeepScreenPixels;});
it('normalizes unequal caster selection including overlaps and a low probability target', () => {
  const spheres: CasterSphere[] = [[0,0,2,1],[.5,0,2,1],[0,0,-2,1]];
  const weights = [1,.4,.05];
  let integral=0;const n=100000;
  for(let i=0;i<n;i++) {
    const z=1-2*(i+.5)/n, phi=i*2.399963229728653, radius=Math.sqrt(1-z*z);
    integral+=casterDirectionPdf([0,0,0],[radius*Math.cos(phi),radius*Math.sin(phi),z],spheres,weights)*4*Math.PI/n;
  }
  expect(integral).toBeCloseTo(1,2);
  expect(casterDirectionPdf([0,0,0],[0,0,-1],spheres,weights)).toBeGreaterThan(0);
});
it('preserves the uniform size and defaults while packing independent experiments', () => {
  gpu();const shader=causticLightCompute({NUM_MAPS:1,NUM_UNIFORM_LIGHTS:1,TLAS_STACK_SIZE:8,BLAS_STACK_SIZE:32},1,false);
  const definition=makeShaderDataDefinitions(shader),offset=definition.structs.CausticLightUniform.fields.experiments.offset;
  const options={casterSphere:[0,0,0,1],viewProjection:Array(16).fill(0),photons:1,batch:1,cameraScale:1};
  expect(definition.uniforms.caustic.size).toBe(112);expect(offset).toBe(108);
  expect(new Uint32Array(packCausticLightUniform(options))[offset/4]).toBe(0);
  expect(new Uint32Array(packCausticLightUniform({...options,experiments:3}))[offset/4]).toBe(3);
});
it('adds one radius word per photon without moving either index or direction plane', () => {
  for(const n of [1,129,32769,5000000]){
    const original=photonLayout(n),local=photonLayout(n,true);
    expect(local.directions).toBe(original.directions);
    expect(local.coarseIndices).toBe(original.coarseIndices);
    expect(local.texels-original.texels).toBe(n);
  }
});
it('generates independent position, normal and footprint audit shaders', () => {
  gpu();
  for(const group of [80,81,82,100,120,130,150]) {
    const definition=makeShaderDataDefinitions(rayTrace({hasDisplacement:false,photonMapping:true,debugGroup:group}));
    expect(definition.entryPoints.main.stage).toBe(4);
  }
});
