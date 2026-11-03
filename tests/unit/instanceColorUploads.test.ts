import {expect,it,vi} from 'vitest';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import InstancedMesh from '../../src/scene/InstancedMesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {updateMeshInstances} from '../../src/renderer/prepareMeshBVH';
import {buildWebTLAS} from '../../src/renderer/bvhAccel';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges';

it.each(['webgpu','webgl'] as const)('%s queues color writes independently of transforms, geometry and lights', backend=>{
  const mesh=new InstancedMesh(createCubeGeometry(),new OpenPBRMaterial(),{count:2,colors:new Float32Array(6).fill(1)});
  const meshes=[mesh], prepared=updateMeshInstances(meshes), tlas=buildWebTLAS(prepared.instances,prepared.blases);
  const pass=Object.create((backend==='webgpu'?WGPURayTracePass:WebGLRayTracePass).prototype) as any;
  Object.assign(pass,{_meshes:meshes,_preparedMeshData:prepared,_tlas:tlas,_materialData:{},_materialChanges:new MaterialChangeTracker(),
    _dirtyTransformMeshes:new Set(),_dirtyColorMeshes:new Set(),_pendingGeometryUpdates:new Set(),_meshSnapshot:[],
    _needsUpdateMeshData:false,_needsUpdateMeshMembership:false,_needsRefitTLAS:false,_needsUpdateLightSamplingData:false});
  const upload=vi.fn();
  if(backend==='webgpu'){pass._instancesBuffer={};pass._device={queue:{writeBuffer:upload}};}
  else {pass._renderer={gl:{}};pass._bvhBufferTex={updateDataRange:upload};pass._instancesOffset=tlas.buffer.byteLength/16;
    pass._bvhData=new Float32Array((tlas.buffer.byteLength+tlas.instancesBuffer!.byteLength)/4);}
  const bounds=tlas.buffer.slice(0);
  mesh.colors![0]=.2;mesh.markColorsUpdated();
  expect(pass.setMeshes(meshes,{colors:[mesh]})).toBe(true);
  expect(pass._needsRefitTLAS).toBe(false);expect(pass._needsUpdateMeshData).toBe(false);expect(pass._needsUpdateMeshMembership).toBe(false);
  expect(pass._needsUpdateLightSamplingData).toBe(false);expect(pass._dirtyTransformMeshes.size).toBe(0);
  pass._updateMeshColors();
  expect(upload).toHaveBeenCalledTimes(2);expect(tlas.buffer).toEqual(bounds);expect(pass._dirtyColorMeshes.size).toBe(0);
  for(const args of upload.mock.calls){const offset=backend==='webgpu'?args[1]:args[2]-tlas.buffer.byteLength,size=backend==='webgpu'?args[4]:args[3];expect(offset%160).toBe(144);expect(size).toBe(16);}
  if(backend==='webgl')expect(Array.from(pass._bvhData.subarray(tlas.buffer.byteLength/4))).toEqual(Array.from(new Float32Array(tlas.instancesBuffer!)).map((v,i)=>upload.mock.calls.some(([,,o,n])=>i*4>=o-tlas.buffer.byteLength&&i*4<o-tlas.buffer.byteLength+n)?v:0));
});
