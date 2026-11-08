import {describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.stubGlobal('location',{href:'https://viewer.example.com/',search:'',hash:'',pathname:'/'});vi.stubGlobal('document',{baseURI:'https://viewer.example.com/'});vi.stubGlobal('window',{});vi.stubGlobal('history',{replaceState:vi.fn()});});
import {ViewerEngine} from '../src/engine/ViewerEngine';
import type {PathedFile} from '../src/engine/droppedFiles';
const xml='<materialx version="1.39"><texcoord name="uv" type="vector2"/><extract name="a" type="float"><input name="in" type="vector2" nodename="uv"/></extract><open_pbr_surface name="S" type="surfaceshader"><input name="geometry_opacity" type="float" nodename="a"/></open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>';
describe('viewer MaterialX graph replacement',()=>{
 it('resets hidden source controls when replacing a previously imported material',async()=>{
  const setTextures=vi.fn(async()=>true),receiver={materials:{setTextures}};
  const file=new Blob([xml],{type:'application/xml'}) as File;
  expect(await ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine,'id',[{file,path:'material.mtlx'}] as PathedFile[])).toBe(true);
  const args=setTextures.mock.calls[0] as unknown as unknown[];
  expect(args[2]).toEqual(expect.objectContaining({alphaMode:'auto',alphaCutoff:0,baseWeight:1,coatDarkening:1}));
  expect(args[6]).toEqual(expect.objectContaining({terminal:expect.objectContaining({opacity:expect.anything()})}));
 });
});

it('does not commit an import cancelled while its files are being read', async () => {
 const controller = new AbortController(), setTextures = vi.fn();
 let finish!: (text: string) => void;
 const text = new Promise<string>(resolve => { finish = resolve; });
 const file = { text: () => text } as File;
 const receiver = { materials: { setTextures } };
 const task = ViewerEngine.prototype.importMaterialX.call(receiver as unknown as ViewerEngine, 'id', [{ file, path: 'm.mtlx' }], controller.signal);
 controller.abort(); finish(xml);
 expect(await task).toBe(false);
 expect(setTextures).not.toHaveBeenCalled();
});

it('accepts explicit default tangent normal maps but diagnoses object space', async () => {
 const { parseMaterialXGraph, pruneInactiveInputs } = await import('../src/engine/materialxGraph');
 const doc = (space: string) => `<materialx version="1.38"><image name="image" type="vector3"><input name="file" type="filename" value="normal.png"/></image><normalmap name="n" type="vector3"><input name="in" type="vector3" nodename="image"/>${space}</normalmap><open_pbr_surface name="S" type="surfaceshader"><input name="geometry_normal" type="vector3" nodename="n"/></open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" nodename="S"/></surfacematerial></materialx>`;
 const explicit = parseMaterialXGraph(doc('<input name="space" type="string" value="tangent"/>'));
 const implicit = parseMaterialXGraph(doc(''));
 expect(explicit.warnings).toEqual([]);
 expect(explicit.graph?.nodes).toEqual(implicit.graph?.nodes);
 expect(parseMaterialXGraph(doc('<input name="space" type="string" value="object"/>')).warnings.join()).toContain('Unsupported input space');
 const restored = pruneInactiveInputs([{ id: 'n', category: 'normalmap', type: 'vector3', inputs: { space: { type: 'string', value: 'tangent' } } }], {});
 expect(restored.nodes[0].inputs?.space).toBeUndefined();
});
