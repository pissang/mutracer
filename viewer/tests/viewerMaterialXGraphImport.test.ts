import {describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.stubGlobal('location',{href:'https://viewer.example.com/',search:'',hash:'',pathname:'/'});vi.stubGlobal('document',{baseURI:'https://viewer.example.com/'});vi.stubGlobal('window',{});vi.stubGlobal('history',{replaceState:vi.fn()});});
import {ViewerEngine} from '../src/engine/ViewerEngine';
import type {PathedFile} from '../src/engine/droppedFiles';
const xml='<materialx version="1.39"><texcoord name="uv" type="vector2"/><extract name="a" type="float"><input name="in" type="vector2" nodename="uv"/></extract><open_pbr_surface name="S" type="surfaceshader"><input name="geometry_opacity" type="float" nodename="a"/></open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>';
describe('viewer MaterialX graph replacement',()=>{
 it('resets hidden source controls when replacing a previously imported material',async()=>{
  const setTextures=vi.fn(async()=>{}),receiver={materials:{setTextures}};
  const file=new Blob([xml],{type:'application/xml'}) as File;
  expect(await ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file,path:'material.mtlx'}] as PathedFile[])).toBe(true);
  const args=setTextures.mock.calls[0] as unknown as unknown[];
  expect(args[2]).toEqual(expect.objectContaining({alphaMode:'auto',alphaCutoff:0,baseWeight:1,coatDarkening:1}));
  expect(args[6]).toEqual(expect.objectContaining({terminal:expect.objectContaining({opacity:expect.anything()})}));
 });
});
