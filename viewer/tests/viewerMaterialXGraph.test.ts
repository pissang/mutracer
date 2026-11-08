import {describe,it,expect} from 'vitest';
import {parseMaterialXGraph,pruneInactiveInputs} from '../src/engine/materialxGraph';
import {MaterialGraph} from '@meimu/mutracer';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate';
const doc=(body:string,category='open_pbr_surface',inputs='')=>`<materialx version="1.39">${body}<${category} name="S" type="surfaceshader">${inputs}</${category}><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>`;
describe('MaterialX graph import',()=>{
 it('uses the official Standard Surface conversion for tinted coated metals',()=>{
  const m=parseMaterialXGraph(doc('','standard_surface','<input name="base_color" type="color3" value="0.8,0.4,0.2"/><input name="metalness" type="float" value="1"/><input name="specular" type="float" value="0.2"/><input name="coat" type="float" value="0.5"/><input name="coat_color" type="color3" value="0.2,0.6,1"/><input name="sheen_roughness" type="float" value="0.25"/>'));
  expect(m.warnings).toEqual([]);expect(m.graph).toBeUndefined();expect(m.values.specularWeight).toBe(1);expect(m.values.coatWeight).toBe(0);
  expect(m.values.baseColor).toEqual([0.48,0.32000000000000006,0.2]);expect(m.values.fuzzRoughness).toBeCloseTo(Math.pow(0.25,0.4));
 });
 it('converts black specular color and opacity by the official first-channel rule',()=>{
  const m=parseMaterialXGraph(doc('','standard_surface','<input name="specular_color" type="color3" value="0,0,0"/><input name="opacity" type="color3" value="0.2,0.8,1"/>'));
  expect(m.values.specularColor).toEqual([1,1,1]);expect(m.values.opacity).toBe(0.2);expect(m.values.thinWalled).toBe(false);
 });
 it('keeps varying inputs in a graph while folding uniform terminals',()=>{
  const m=parseMaterialXGraph(doc('<texcoord name="uv" type="vector2"/><extract name="x" type="float"><input name="in" type="vector2" nodename="uv"/></extract>','open_pbr_surface','<input name="base_metalness" type="float" value="0.6"/><input name="specular_roughness" type="float" nodename="x"/>'));
  expect(m.values.baseMetalness).toBe(0.6);expect(m.graph).toBeDefined();expect(m.coverage).toBe('complete');expect(evaluateGraph(normalizeGraph(m.graph!),{uv:[0.3,0.8]}).specularRoughness).toEqual([0.3]);
 });
 it.each([['x','float',[0.2]],['yx','vector2',[0.8,0.2]],['xy01','color4',[0.2,0.8,0,1]]] as const)('upgrades swizzle %s to extract/combine', (channels,type,want)=>{
  const m=parseMaterialXGraph(doc(`<texcoord name="uv" type="vector2"/><swizzle name="s" type="${type}"><input name="in" type="vector2" nodename="uv"/><input name="channels" type="string" value="${channels}"/></swizzle><convert name="c" type="color3"><input name="in" type="${type}" nodename="s"/></convert>`,'open_pbr_surface','<input name="base_color" type="color3" nodename="c"/>'));
  expect(m.warnings).toEqual([]);expect(m.graph!.nodes.some(n=>n.category==='swizzle')).toBe(false);
  const result=evaluateGraph(normalizeGraph(m.graph!),{uv:[0.2,0.8]}).baseColor;
  expect(result.slice(0,Math.min(want.length,3))).toEqual(want.length===1?[0.2]:want.slice(0,3));
 });
 it('keeps unknown nodes located for the library fallback',()=>{
  const m=parseMaterialXGraph(doc('<custom_noise name="alien" type="color3"/>','open_pbr_surface','<input name="base_color" type="color3" nodename="alien"/>'));
  expect(m.graph).toBeDefined();expect(m.warnings[0]).toContain('alien');expect(normalizeGraph(m.graph!).diagnostics[0].code).toBe('unsupported-node');expect(m.coverage).toBe('fallback');
 });
 it('preserves connected Standard Surface conversion logic',()=>{
  const m=parseMaterialXGraph(doc('<texcoord name="uv" type="vector2"/><extract name="x" type="float"><input name="in" type="vector2" nodename="uv"/></extract>','standard_surface','<input name="metalness" type="float" nodename="x"/><input name="specular" type="float" value="0.2"/><input name="coat" type="float" value="0.5"/>'));
  expect(m.warnings).toEqual([]);const g=normalizeGraph(m.graph!);
  expect(evaluateGraph(g,{uv:[0,0]}).specularWeight).toEqual([0.2]);expect(evaluateGraph(g,{uv:[1,0]}).specularWeight).toEqual([1]);expect(evaluateGraph(g,{uv:[1,0]}).coatWeight).toEqual([0]);
 });
 it('upgrades literal, scalar-source and legacy channels swizzles',()=>{
  const m=parseMaterialXGraph(doc('<constant name="x" type="float"><input name="value" type="float" value="0.4"/></constant><swizzle name="s" type="color3"><input name="in" type="float" nodename="x"/><input name="channels" type="string" value="x10"/></swizzle>','open_pbr_surface','<input name="base_color" type="color3" nodename="s"/>'));
  expect(m.values.baseColor).toEqual([0.4,1,0]);expect(m.graph).toBeUndefined();
  const legacy=parseMaterialXGraph(doc('<texcoord name="uv" type="vector2"/>','open_pbr_surface','<input name="specular_roughness" type="float" nodename="uv" channels="y"/>'));
  expect(legacy.warnings).toEqual([]);expect(evaluateGraph(normalizeGraph(legacy.graph!),{uv:[0.2,0.8]}).specularRoughness).toEqual([0.8]);
  const literal=parseMaterialXGraph(doc('<swizzle name="s" type="color3"><input name="in" type="vector2" value="0.2,0.8"/><input name="channels" type="string" value="y"/></swizzle>','open_pbr_surface','<input name="base_color" type="color3" nodename="s"/>'));
  expect(literal.values.baseColor).toEqual([0.8,0.2,0.2]);
 });
 it('diagnoses Standard Surface inputs outside the official conversion subset',()=>{
  const m=parseMaterialXGraph(doc('','standard_surface','<input name="coat_normal" type="vector3" value="0,1,0"/>'));expect(m.warnings.some(w=>w.includes('coatNormal'))).toBe(true);
 });
 it('maps glTF coverage controls and reports unhandled surface inputs',()=>{
  const m=parseMaterialXGraph(doc('','gltf_pbr','<input name="alpha_mode" type="integer" value="1"/><input name="alpha_cutoff" type="float" value="0.4"/><input name="alpha" type="float" value="0.2"/><input name="custom_port" type="float" value="0.8"/>'));
  expect(m.values.alphaMode).toBe('mask');expect(m.values.alphaCutoff).toBe(0.4);expect(m.values.opacity).toBe(0.2);expect(m.warnings.some(w=>w.includes('custom_port'))).toBe(true);
 });
 it('retains a uniform normal connection and diagnoses unknown constant surface inputs',()=>{
  const m=parseMaterialXGraph(doc('','open_pbr_surface','<input name="geometry_normal" type="vector3" value="0,1,0"/><input name="mystery" type="float" value="1"/>'));
  expect(m.graph!.terminal.normal).toBeDefined();expect(normalizeGraph(m.graph!).diagnostics).toContainEqual(expect.objectContaining({code:'unsupported-terminal',port:'mystery'}));
 });
 it('reports lit emission fallback and keeps image file paths',()=>{
  const m=parseMaterialXGraph(doc('<image name="image" type="color3"><input name="file" type="filename" value="textures/light.png"/></image>','open_pbr_surface','<input name="emission_color" type="color3" nodename="image"/><input name="emission_luminance" type="float" value="2"/>'));
  expect(m.images.get('image')?.file).toBe('textures/light.png');expect(m.warnings.some(s=>s.includes('Lit emission'))).toBe(true);
 });
 it('ignores exporter inputs that have no effect and still reports active ones',()=>{
  const image=(extra:string)=>`<texcoord name="uv" type="vector2"/><image name="rough" type="float"><input name="texcoord" type="vector2" nodename="uv"/><input name="file" type="filename" value="r.png"/>${extra}</image><normal name="n" type="vector3"><input name="space" type="string" value="world"/></normal>`;
  const inputs=(rotation:string)=>`<input name="specular_roughness" type="float" nodename="rough"/><input name="specular_rotation" type="float" value="${rotation}"/><input name="coat_normal" type="vector3" nodename="n"/>`;
  const quiet=parseMaterialXGraph(doc(image('<input name="layer" type="string" value=""/><input name="frameoffset" type="integer" value="0"/><input name="frameendaction" type="string" value="constant"/>'),'standard_surface',inputs('0')));
  expect(quiet.warnings).toEqual([]);expect(Object.keys(quiet.graph!.terminal)).toEqual(['specularRoughness']);
  const active=parseMaterialXGraph(doc(image('<input name="frameoffset" type="integer" value="2"/>'),'standard_surface',inputs('0.3')));
  expect(active.warnings).toEqual(expect.arrayContaining([expect.stringContaining('frameoffset'),expect.stringContaining('specularRotation')]));
 });
 it('prunes inactive inputs from graphs saved by an earlier importer',()=>{
  const nodes=[{id:'uv',category:'texcoord',type:'vector2' as const},
   {id:'rough',category:'image',type:'float' as const,inputs:{texcoord:{type:'vector2' as const,connection:{node:'uv'}},layer:{type:'string' as const,value:''},frameoffset:{type:'integer' as const,value:0}}},
   {id:'n',category:'normal',type:'vector3' as const,inputs:{space:{type:'string' as const,value:'world'}}},
   {id:'rotation',category:'constant',type:'float' as const,inputs:{value:{type:'float' as const,value:0}}},
   {id:'tilt',category:'constant',type:'float' as const,inputs:{value:{type:'float' as const,value:0.5}}}];
  const pruned=pruneInactiveInputs(nodes,{specularRoughness:{node:'rough'},coatNormal:{node:'n'},specularRotation:{node:'rotation'},coatRotation:{node:'tilt'}});
  expect(Object.keys(pruned.terminal)).toEqual(['specularRoughness','coatRotation']);
  expect(Object.keys(pruned.nodes[1].inputs!)).toEqual(['texcoord']);
  expect(normalizeGraph(new MaterialGraph({nodes:pruned.nodes,terminal:{specularRoughness:{node:'rough'}}})).diagnostics).toEqual([]);
 });
});
