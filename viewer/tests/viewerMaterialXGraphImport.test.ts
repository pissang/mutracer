import {describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.stubGlobal('location',{href:'https://viewer.example.com/',search:'',hash:'',pathname:'/'});vi.stubGlobal('document',{baseURI:'https://viewer.example.com/'});vi.stubGlobal('window',{});vi.stubGlobal('history',{replaceState:vi.fn()});});
import {ViewerEngine} from '../src/engine/ViewerEngine';
import type {PathedFile} from '../src/engine/droppedFiles';
import {bakeDisplacement} from '../src/engine/materialxBakeClient';
vi.mock('../src/engine/materialxBakeClient',()=>({bakeDisplacement:vi.fn()}));
const xml='<materialx version="1.39"><texcoord name="uv" type="vector2"/><extract name="a" type="float"><input name="in" type="vector2" nodename="uv"/></extract><open_pbr_surface name="S" type="surfaceshader"><input name="geometry_opacity" type="float" nodename="a"/></open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>';
describe('viewer MaterialX graph replacement',()=>{
 it.each(['replace','reset'])('does not install a late bake after %s',async action=>{
  let complete!:(value:Awaited<ReturnType<typeof bakeDisplacement>>)=>void;
  vi.mocked(bakeDisplacement).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
  const setTextures=vi.fn(async()=>{}),reset=vi.fn(),receiver={materials:{setTextures,reset}};
  const source='<materialx version="1.39"><noise2d name="h" type="float"/><standard_surface name="S" type="surfaceshader"/><displacement name="D" type="displacementshader"><input name="displacement" type="float" nodename="h"/></displacement><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/><input name="displacementshader" type="displacementshader" nodename="D"/></surfacematerial></materialx>';
  const pending=ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file:new Blob([source]) as File,path:'h.mtlx'}]);
  await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
  if(action==='reset')ViewerEngine.prototype.resetMaterial.call(receiver as unknown as ViewerEngine,'id');
  else await ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file:new Blob([xml]) as File,path:'new.mtlx'}]);
  complete({file:new Blob(['height']),scale:.2,bias:0,maxError:0,width:1024,height:1024,backend:'webgpu',timings:{compileMs:0,executeMs:1,readbackMs:1,cacheHit:true}});
  expect(await pending).toBe(false);expect(setTextures).toHaveBeenCalledTimes(action==='replace'?1:0);
 });
 it('waits for background height baking and installs surface and height as one undo step',async()=>{
  let complete!:(value:Awaited<ReturnType<typeof bakeDisplacement>>)=>void;
  vi.mocked(bakeDisplacement).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
  const setTextures=vi.fn(async()=>{}),receiver={materials:{setTextures}};
  const text='<materialx version="1.39"><noise2d name="height" type="float"/><standard_surface name="S" type="surfaceshader"/><displacement name="D" type="displacementshader"><input name="displacement" type="float" nodename="height"/></displacement><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/><input name="displacementshader" type="displacementshader" nodename="D"/></surfacematerial></materialx>';
  const promise=ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file:new Blob([text]) as File,path:'height.mtlx'}]);
  await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));expect(setTextures).not.toHaveBeenCalled();
  const file=new Blob(['baked PNG'],{type:'image/png'});complete({file,scale:.2,bias:-.1,maxError:.2/510,width:1024,height:1024,backend:'webgpu',timings:{compileMs:10,executeMs:1,readbackMs:1,cacheHit:false}});
  expect(await promise).toBe(true);expect(setTextures).toHaveBeenCalledTimes(1);
  const args=setTextures.mock.calls[0] as unknown as unknown[];
  expect(args[1]).toEqual(expect.objectContaining({displacementMap:file}));expect(args[2]).toEqual(expect.objectContaining({displacementScale:.2,displacementBias:-.1}));
  expect(args[7]).toEqual({displacementMap:{uvScale:[1,1],flipY:true,uvChannel:0,wrapS:'repeat',wrapT:'repeat'}});
 });
 it('resets hidden source controls when replacing a previously imported material',async()=>{
  const setTextures=vi.fn(async()=>{}),receiver={materials:{setTextures}};
  const file=new Blob([xml],{type:'application/xml'}) as File;
  expect(await ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file,path:'material.mtlx'}] as PathedFile[])).toBe(true);
  const args=setTextures.mock.calls[0] as unknown as unknown[];
  expect(args[2]).toEqual(expect.objectContaining({alphaMode:'auto',alphaCutoff:0,baseWeight:1,coatDarkening:1}));
  expect(args[6]).toEqual(expect.objectContaining({terminal:expect.objectContaining({opacity:expect.anything()})}));
 });
});
