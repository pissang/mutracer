import {describe,it,expect,vi} from 'vitest';
import {parseMaterialXGraph} from '../src/engine/materialxGraph';
import {loadDirectMaterialX,type MaterialXPackage} from '../src/engine/materialxFiles';
const doc=(nodes:string,inputs:string)=>`<materialx version="1.39">${nodes}<open_pbr_surface name="S" type="surfaceshader">${inputs}</open_pbr_surface><surfacematerial name="M"><input name="surfaceshader" nodename="S"/></surfacematerial></materialx>`;
const image=(type='color3',extra='')=>`<image name="i" type="${type}"><input name="file" type="filename" value="image.png"/>${extra}</image>`;
const port=(name:string,type:string,node='i')=>`<input name="${name}" type="${type}" nodename="${node}"/>`;
describe('exact MaterialX slot lowering',()=>{
 it('retains color decoding and ignores image alpha on base color',()=>{
  const m=parseMaterialXGraph(doc(image(),port('base_color','color3')));
  expect(m.direct?.maps).toEqual([{node:'i',slot:'map',channels:[0,1,2,-2],transform:{uvScale:[1,1],uvOffset:[0,0],uvChannel:0,flipY:true,wrapS:'repeat',wrapT:'repeat',colorSpace:'srgb'}}]);
  expect(m.direct?.values).toEqual({baseColor:[1,1,1],mapAlphaUsage:'opaque'});
 });
 it('moves a raw scalar channel into the slot channel without baking its value',()=>{
  const m=parseMaterialXGraph(doc(image('vector3')+'<extract name="g" type="float"><input name="in" type="vector3" nodename="i"/><input name="index" type="integer" value="2"/></extract>',port('specular_roughness','float','g')));
  expect(m.direct?.maps[0]).toMatchObject({slot:'roughnessMap',channels:[-1,2,-1,-2],transform:{colorSpace:'linear'}});
  expect(m.direct?.values.specularRoughness).toBe(1);
 });
 it('preserves a UV1 placement and its independent wrapping',()=>{
  const uv='<texcoord name="uv" type="vector2"><input name="index" type="integer" value="1"/></texcoord><place2d name="p" type="vector2"><input name="texcoord" type="vector2" nodename="uv"/><input name="scale" type="vector2" value="2,4"/><input name="offset" type="vector2" value="0.25,0.5"/></place2d>';
  const m=parseMaterialXGraph(doc(uv+image('color3','<input name="texcoord" type="vector2" nodename="p"/><input name="uaddressmode" type="string" value="mirror"/><input name="vaddressmode" type="string" value="clamp"/>'),port('base_color','color3')));
  expect(m.direct?.maps[0].transform).toMatchObject({uvScale:[.5,.25],uvOffset:[-.25, -.5],uvChannel:1,wrapS:'mirrored-repeat',wrapT:'clamp-to-edge'});
 });
 it('selects MaterialX normals explicitly and retains nondefault shading frames',()=>{
  const normal=(extra='')=>image('vector3')+`<normalmap name="n" type="vector3"><input name="in" type="vector3" nodename="i"/>${extra}</normalmap>`;
  const m=parseMaterialXGraph(doc(normal(),port('geometry_normal','vector3','n')));
  expect(m.direct?.maps[0]).toMatchObject({slot:'normalMap',transform:{normalMapFrame:'materialx',colorSpace:'linear'}});
  expect(m.direct?.values.normalScale).toEqual([1,1]);
  expect(parseMaterialXGraph(doc(normal('<input name="scale" type="float" value="0.5"/>'),port('geometry_normal','vector3','n'))).direct?.values.normalScale).toEqual([.5,.5]);
  for(const extra of ['<input name="normal" type="vector3" value="0,1,0"/>']){
   const custom=parseMaterialXGraph(doc(normal(extra),port('geometry_normal','vector3','n')));expect(custom.graph).toBeDefined();expect(custom.direct).toBeUndefined();
  }
 });
 it('retains a graph-only anisotropy frame when no normal slot can carry it',()=>{
  const m=parseMaterialXGraph(doc(image(),port('base_color','color3')+'<input name="specular_roughness_anisotropy" type="float" value="0.5"/>'));
  expect(m.graph).toBeDefined();expect(m.direct).toBeUndefined();
 });
 it('does not move sRGB decoding before a scalar channel sample',()=>{
  const m=parseMaterialXGraph(doc(image()+'<extract name="r" type="float"><input name="in" type="color3" nodename="i"/></extract>',port('specular_roughness','float','r')));
  expect(m.direct).toBeUndefined();expect(m.graph).toBeDefined();
 });
 it('retains bias, nonlinear operations and rotation instead of approximating them',()=>{
  for(const category of ['add','power']){
   const m=parseMaterialXGraph(doc(image('float')+`<${category} name="math" type="float"><input name="in1" type="float" nodename="i"/><input name="in2" type="float" value="0.2"/></${category}>`,port('specular_roughness','float','math')));expect(m.direct).toBeUndefined();
  }
  const m=parseMaterialXGraph(doc('<place2d name="p" type="vector2"><input name="rotate" type="float" value="90"/></place2d>'+image('color3','<input name="texcoord" type="vector2" nodename="p"/>'),port('base_color','color3')));expect(m.direct).toBeUndefined();
 });
 it('retains two successive normal decodes',()=>{
  const m=parseMaterialXGraph(doc(image('vector3')+'<normalmap name="n" type="vector3"><input name="in" type="vector3" nodename="i"/></normalmap><normalmap name="n2" type="vector3"><input name="in" type="vector3" nodename="n"/></normalmap>',port('geometry_normal','vector3','n2')));expect(m.direct).toBeUndefined();
 });
 it('does not mistake a scaled decoded normal for a scale on the input image',()=>{
  const m=parseMaterialXGraph(doc(image('vector3')+'<normalmap name="n" type="vector3"><input name="in" type="vector3" nodename="i"/></normalmap><multiply name="mul" type="vector3"><input name="in1" type="vector3" nodename="n"/><input name="in2" type="float" value="0.5"/></multiply>',port('geometry_normal','vector3','mul')));expect(m.direct).toBeUndefined();
 });
 it('keeps the authored missing-image default and graph on resource failure',async()=>{
  const m=parseMaterialXGraph(doc(image(),port('base_color','color3'))),graph=m.graph;
  const pkg:MaterialXPackage={text:'',path:'m.mtlx',resolve:()=>undefined};
  expect(await loadDirectMaterialX(m,pkg)).toBeUndefined();expect(m.graph).toBe(graph);
  vi.stubGlobal('createImageBitmap',vi.fn().mockRejectedValue(new Error('bad image')));
  expect(await loadDirectMaterialX(m,{...pkg,resolve:()=>new Blob(['invalid'])})).toBeUndefined();expect(m.graph).toBe(graph);vi.unstubAllGlobals();
 });
});
