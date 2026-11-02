import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {packVolumes, VOLUME_FLOATS} from '../../src/renderer/volumeData';
import type {SceneVolume} from '../../src/scene/SceneVolume';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector';
import {makeWebRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';
import core from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
const volume = (): SceneVolume => ({density: .4, bounds: {min: [-1,-1,-1], max: [1,1,1]}});
afterEach(() => { vi.unstubAllGlobals(); });
describe('heterogeneous volume data', () => {
  it('resolves all defaults and packs aligned web records', () => {
    const f = {...volume(), noise: {size: [2,3,4] as [number,number,number]}};
    const packed = packVolumes([f]);
    expect(packed.hasNoise).toBe(true); expect(VOLUME_FLOATS).toBe(36);
    expect(packVolumes([{...f,noise:{...f.noise,warp:0}}]).data).toEqual(packed.data);
    expect(Array.from(packed.data.slice(24,36))).toEqual([2,3,4,4,0,0,0,.5,Math.fround(.3),0,1,0]);
    expect(packVolumes([volume()]).hasNoise).toBe(false);
    expect(packVolumes([{...f,noise:{...f.noise,warp:32}}]).data[35]).toBe(32);
    expect(packVolumes([{...volume(),edgeFade:.2}]).hasNoise).toBe(true);
    vi.stubGlobal('GPUShaderStage',{VERTEX:1,FRAGMENT:2,COMPUTE:4});
    for (const hasVolumeNoise of [false,true]) {
      const uniform=makeWebRayTraceUniform(hasVolumeNoise);
      const definitions=makeShaderDataDefinitions(core({hasVolumes:true,hasVolumeNoise}));
      const record=definitions.structs.VolumeRecord;
      expect(record.size).toBe((hasVolumeNoise?36:24)*4);
      expect(definitions.structs.RayTraceUniform.size).toBe(uniform.buffer.byteLength);
      expect(definitions.structs.RayTraceUniform.fields.volumeRecords.offset).toBe(uniform.views.volumeRecords.byteOffset);
    }
  });
  it('rejects invalid field values before a commit', () => {
    const invalid=[{noise:null},{edgeFade:-1},{edgeFade:1.1},{edgeFade:NaN},
      ...[{size:[0,1,1]},{size:[1,-1,1]},{size:[1,Infinity,1]},{size:[1e-100,1,1]},
        {octaves:0},{octaves:7},{octaves:2.5},{octaves:null},{coverage:-.1},{coverage:null},
        {softness:2},{softness:null},{warp:-1},{warp:NaN},{warp:Infinity},{warp:null},{offset:[0,NaN,0]},{offset:null}].map(noise=>({noise:{size:[1,1,1],...noise}}))];
    for (const patch of invalid) expect(()=>packVolumes([{...volume(),...patch} as SceneVolume])).toThrow(RangeError);
  });
  it('changes variants only when the first or last modulated volume changes', () => {
    const detector=new SceneChangeDetector(),f=volume(),scene={meshes:[],lights:[],volumes:[f]};
    detector.detect(scene);detector.commit();f.noise={size:[1,2,3]};
    expect(detector.detect(scene).volumeStructure).toBe(true);detector.commit();
    for (const edit of [()=>f.noise!.size[0]=2,()=>f.noise!.offset=[1,2,3],()=>f.noise!.coverage=.8,
      ()=>f.noise!.octaves=6,()=>f.noise!.warp=1,()=>f.noise!.softness=.2,()=>f.edgeFade=.3]) {
      edit(); const change=detector.detect(scene); expect(change.volumes).toBe(true);expect(change.volumeStructure).toBe(false);detector.commit();
    }
    delete f.noise;expect(detector.detect(scene).volumeStructure).toBe(false);detector.commit();
    f.edgeFade=0;expect(detector.detect(scene).volumeStructure).toBe(true);
  });
  it('switches WebGL programs asynchronously and removes retired noise bindings', () => {
    const setShader=vi.fn(),setUniforms=vi.fn(),setDefines=vi.fn();
    const pass={_hasVolumes:false,_hasVolumeNoise:false,_mainPass:{setShader,setUniforms,setDefines}};
    const upload=WebGLRayTracePass.prototype.setVolumes.bind(pass as unknown as WebGLRayTracePass);
    const f=volume();upload([f]);f.edgeFade=.5;upload([f]);
    expect(setShader.mock.calls.at(-1)![0].defines.HAS_VOLUME_NOISE).toBe(true);
    expect(setShader.mock.calls.at(-1)![0].parallelCompile).toBe(true);
    f.edgeFade=.3;upload([f]);expect(setShader).toHaveBeenCalledTimes(2);
    f.edgeFade=0;upload([f]);
    expect(setShader.mock.calls.at(-1)![1]).toContain('volumeNoiseParams');
    expect(setShader.mock.calls.at(-1)![2]).toContain('HAS_VOLUME_NOISE');
  });
});
