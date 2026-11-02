import {registerMnee} from '../../src/research/mnee/index';
import {causticLightCompute,causticAccumulateCompute,CAUSTIC_UNIFORM_BYTES} from '../../src/renderer/wgsl/causticLight.compute';
import {packCausticLightUniform} from '../../src/renderer/WGPUCausticLightPass';
import {createNormalizeRayTraceOutputWGSL} from '../../src/renderer/WGPURayTraceOutput';
import Mesh from '../../src/scene/Mesh';
import Geometry,{Attribute} from '../../src/scene/Geometry';
import {createSphereGeometry} from '../../src/util/commonGeometry';
import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {hasStochasticCausticCaster,causticCasterSpheres,casterDirectionPdf,causticCasterSphere,isCausticSpecular} from '../../src/renderer/caustics';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import rayTrace from '../../src/renderer/wgsl/rayTrace.compute';
import fragment from '../../src/renderer/glsl/rayTrace.frag';
import {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import {gpu} from './shaderSourceFormattingFixture';
registerMnee();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
describe('caustic contracts', () => {
  it('preserves the disabled shader across caustic switch settings', () => {
    expect(hash(rayTrace({hasDisplacement: false}))).toMatchSnapshot('WGSL off');
    expect(hash(fragment().main)).toMatchSnapshot('GLSL off');
    expect(rayTrace({hasDisplacement: false, mnee: false, lightTracing: false})).toBe(rayTrace({hasDisplacement: false}));
    expect(fragment(false).main).toBe(fragment().main);
  });
  it('preserves published light and photon transport sources', () => {
    for (const lightTracing of [false,true]) for (const photonMapping of [false,true]) {
      expect(hash(rayTrace({hasDisplacement:false,lightTracing,photonMapping}))).toMatchSnapshot(`camera ${lightTracing}/${photonMapping}`);
    }
    for (const mode of ['lightTracing','photonMapping'] as const) {
      expect(hash(causticLightCompute({NUM_MAPS:1,NUM_UNIFORM_LIGHTS:1,TLAS_STACK_SIZE:8,BLAS_STACK_SIZE:32},1,false,mode))).toMatchSnapshot(mode);
    }
  });
  it('restores the original PM source through the internal opt-out', () => {
    expect(hash(rayTrace({hasDisplacement:false,photonMapping:true,photonDirectSubset:false}))).toBe('c6e9eb196a13097fcab47162d3b43f28b8e29a9edb4e77cefff579ff79a21458');
  });
  it('classifies resolved material combinations', () => {
    for (const [params, smooth] of [
      [{}, false], [{transmissionWeight: 1, specularRoughness: 0}, true],
      [{baseMetalness: 1, specularRoughness: .1}, true],
      [{baseMetalness: 1, specularRoughness: .11}, false],
      [{transmissionWeight: 1, coatWeight: .01}, false],
      [{transmissionWeight: 1, fuzzWeight: .01}, false],
      [{transmissionWeight: 1, subsurfaceWeight: .01}, false],
      [{transmissionWeight: .99}, false],
    ] as const) expect(isCausticSpecular(new OpenPBRMaterial(params))).toBe(smooth);
  });
  it('parses every WGSL switch combination with the existing uniform contract', () => {
    gpu();
    for (const mnee of [false,true]) for (const mneeMethod of ['newton','sms'] as const) for (const lightTracing of [false,true]) for(const photonMapping of [false,true]) {
      const definitions = makeShaderDataDefinitions(rayTrace({hasDisplacement:false,mnee,lightTracing,mneeMethod,photonMapping}));
      expect(definitions.uniforms.rtUniform.size).toBe(makeRayTraceUniform().buffer.byteLength);
      expect(definitions.entryPoints.main.stage).toBe(4);
    }
  });
  it('packs the photon uniform at the WGSL field offsets and stays within storage limits', () => {
    const definitions=makeShaderDataDefinitions(causticLightCompute({NUM_MAPS:1,NUM_UNIFORM_LIGHTS:1,TLAS_STACK_SIZE:8,BLAS_STACK_SIZE:32},1,false));
    const uniform=definitions.uniforms.caustic;
    const bytes=packCausticLightUniform({casterSphere:[1,2,3,4],viewProjection:Array.from({length:16},(_,i)=>i),photons:123,batch:7,mnee:true,cameraScale:.25,casterCount:9});
    expect(uniform.size).toBe(CAUSTIC_UNIFORM_BYTES);expect(bytes.byteLength).toBe(uniform.size);
    const fields=definitions.structs.CausticLightUniform.fields;
    const read=(name:string)=>new Uint32Array(bytes,fields[name].offset,1)[0];
    expect(read('photonCount')).toBe(123);expect(read('batch')).toBe(7);expect(read('mnee')).toBe(1);expect(read('casterCount')).toBe(9);
    expect(new Float32Array(bytes,fields.cameraScale.offset,1)[0]).toBe(.25);
    expect(Object.keys(definitions.storages)).toHaveLength(5);
    expect(Object.keys(makeShaderDataDefinitions(causticAccumulateCompute).storages)).toHaveLength(2);
    for(const layers of [false,true]) {
      const resolve=makeShaderDataDefinitions(createNormalizeRayTraceOutputWGSL(layers,true,true));
      expect(resolve.storages.causticBuffer.binding).toBe(4);
    }
  });
  it('normalizes the overlapping caster mixture and preserves each instance',()=>{
    const spheres:[number,number,number,number][]=[[0,0,4,1],[.8,0,4,1]];
    let integral=0;
    // Equal-solid-angle quadrature catches missing mixture components in overlap.
    const count=100000;
    for(let i=0;i<count;i++){
      const z=1-2*(i+.5)/count,phi=i*2.399963229728653,r=Math.sqrt(1-z*z);
      integral+=casterDirectionPdf([0,0,0],[r*Math.cos(phi),r*Math.sin(phi),z],spheres)*4*Math.PI/count;
    }
    expect(integral).toBeCloseTo(1,2);
    expect(casterDirectionPdf([0,0,0],[0,0,1],spheres)).toBeGreaterThan(casterDirectionPdf([0,0,0],[0,0,1],[spheres[0]]));
    const glass=new Mesh(createSphereGeometry(8,4),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}));
    expect(causticCasterSpheres([glass,glass])).toHaveLength(2);
  });
  it('keeps stochastic smooth coverage on PT while preserving opaque and cutout casters',()=>{
    const mesh=new Mesh(createSphereGeometry(8,4),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0,alphaMode:'blend',geometryOpacity:.5}));
    expect(hasStochasticCausticCaster([mesh])).toBe(true);
    mesh.materials[0].alphaMode='mask';expect(hasStochasticCausticCaster([mesh])).toBe(false);
    mesh.materials[0].alphaMode='opaque';expect(hasStochasticCausticCaster([mesh])).toBe(false);
    mesh.materials[0].alphaMode='blend';mesh.materials[0].transmissionWeight=0;expect(hasStochasticCausticCaster([mesh])).toBe(false);
  });
  it('collects raw geometry and follows deformation notifications without caller bounds',()=>{
    const positions=new Float32Array([0,0,0,2,0,0,0,2,0]);
    const geometry=new Geometry({position:new Attribute(positions,3),indices:new Attribute(new Uint32Array([0,1,2]),1)});
    const mesh=new Mesh(geometry,new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}));mesh.position=[3,2,1];
    causticCasterSphere([mesh]).slice(0,3).forEach((v,i)=>expect(v).toBeCloseTo([4,3,1][i],12));
    positions[3]=4;geometry.markVerticesUpdated();
    const sphere=causticCasterSphere([mesh]);sphere.slice(0,3).forEach((v,i)=>expect(v).toBeCloseTo([5,3,1][i],12));
    for(let i=0;i<positions.length;i+=3)expect(Math.hypot(positions[i]+3-sphere[0],positions[i+1]+2-sphere[1],positions[i+2]+1-sphere[2])).toBeLessThan(sphere[3]);
  });
  it('encloses transformed casters and excludes diffuse meshes', () => {
    const glass=new Mesh(createSphereGeometry(8,4),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}));glass.position=[3,2,1];
    const diffuse=new Mesh(createSphereGeometry(8,4),new OpenPBRMaterial());diffuse.position=[100,0,0];
    const sphere=causticCasterSphere([glass,diffuse]);
    expect(sphere.slice(0,3)).toEqual([3,2,1]);expect(sphere[3]).toBeGreaterThan(Math.sqrt(3));
    expect(causticCasterSphere([diffuse])).toEqual([0,0,0,0]);
  });

});
