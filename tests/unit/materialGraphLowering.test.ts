import {describe,it,expect} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Texture from '../../src/scene/Texture.js';
import {SlotTextures,materialSlotPlan,slotTextureSource,slotTextureSources} from '../../src/renderer/materialGraph/slotTextures.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges.js';
import {planIndependentTextures} from '../../src/renderer/WGPUBindlessTextures.js';
import {materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
import MaterialData from '../../src/renderer/MaterialData.js';
import {planTextureAtlas} from '../../src/renderer/textureAtlas.js';
function fixture() {
    const texture=new Texture({width:1,height:1,data:new Uint8Array([32,64,192,255])});
    texture.colorSpace='linear';texture.uvScale=[2,3];texture.uvOffset=[.1,.2];texture.wrapS='mirrored-repeat';
    const graph=new MaterialGraph({nodes:[
        {id:'image',category:'image',type:'vector3',inputs:{file:{type:'filename',value:texture}}},
        {id:'channel',category:'extract',type:'float',inputs:{in:{type:'vector3',connection:{node:'image'}},index:{type:'integer',value:2}}},
        {id:'gain',category:'multiply',type:'float',inputs:{in1:{type:'float',connection:{node:'channel'}},in2:{type:'float',value:.5}}}
    ],terminal:{specularRoughness:{node:'gain'}}});
    return {texture,graph,material:new OpenPBRMaterial({graph,specularRoughness:.1})};
}
describe('library graph slot lowering',()=>{
    it('reorders exact channels, composes sampling metadata and leaves authored objects untouched',()=>{
        const {texture,material}=fixture(),lowering=new SlotTextures();
        const result=lowering.lower(material)!;
        expect(result.graph).toBeUndefined();expect(result.aovId).toBe(material.aovId);
        expect(result.specularRoughness).toBe(.5);expect(material.specularRoughness).toBe(.1);expect(material.roughnessMap).toBeUndefined();
        expect(result.roughnessMap).toMatchObject({uvScale:[2,3],uvOffset:[.1,.2],wrapS:'mirrored-repeat'});
        expect((result.roughnessMap!.image as {data:Uint8Array}).data).toEqual(new Uint8Array([32,192,192,255]));
        expect((texture.image as {data:Uint8Array}).data).toEqual(new Uint8Array([32,64,192,255]));
        const buffer=new MaterialData([result],[],()=>1);expect(buffer.bufferData.roughnessMapIndex).toEqual([0]);
    });
    it('reuses derived pixels and texture objects across materials and parameter edits',()=>{
        const {material,graph,texture}=fixture(),lowering=new SlotTextures();
        const first=lowering.lower(material)!;
        graph.setInput('gain','in2',{type:'float',value:.7});const second=lowering.lower(material)!;
        expect(second.roughnessMap).toBe(first.roughnessMap);expect(second.specularRoughness).toBe(.7);
        expect(lowering.lower(new OpenPBRMaterial({graph}))!.roughnessMap).toBe(first.roughnessMap);
        texture.markUpdated();expect(lowering.lower(material)!.roughnessMap!.image).not.toBe(first.roughnessMap!.image);
    });
    it('updates lowerable gain edits without scheduling graph compilation or texture rebuilds',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState(),tracker=new MaterialChangeTracker();
        state.request([material]);tracker.capture([material]);const revision=state.revision;
        expect(state.active.key).toBe('');expect(state.status).toBe('idle');expect(state.requested.structures).toHaveLength(0);
        graph.setInput('gain','in2',{type:'float',value:.75});expect(tracker.classify([material]).level).toBe('params');state.request([material]);
        expect(state.revision).toBeGreaterThan(revision);expect(state.active.key).toBe('');expect(state.status).toBe('idle');
        expect(state.renderMaterials([material])[0].specularRoughness).toBe(.75);
    });
    it('retains the previous direct result while a replacement graph compiles and rejects obsolete completion',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState();state.request([material]);
        const previous=state.renderMaterials([material])[0];
        graph.setNode({id:'gain',category:'add',type:'float',inputs:{in1:{type:'float',connection:{node:'channel'}},in2:{type:'float',value:.1}}});
        state.request([material]);expect(state.status).toBe('compiling');expect(state.renderMaterials([material])[0]).toBe(previous);
        const plan=state.requested,revision=state.revision;
        graph.setInput('gain','in2',{type:'float',value:.2});state.request([material]);
        expect(state.install(plan,revision)).toBe(false);expect(state.renderMaterials([material])[0]).toBe(previous);
        state.fail(state.revision,new Error('driver failure'));expect(state.renderMaterials([material])[0]).toBe(previous);
        state.request([material]);state.install(state.requested,state.revision);expect(state.renderMaterials([material])[0]).toBe(material);
        graph.setNode({id:'gain',category:'multiply',type:'float',inputs:{in1:{type:'float',connection:{node:'channel'}},in2:{type:'float',value:.3}}});
        state.request([material]);expect(state.status).toBe('compiling');expect(state.renderMaterials([material])[0].roughnessMap).toBeDefined();
        state.install(state.requested,state.revision);expect(state.active.key).toBe('');expect(state.status).toBe('idle');
    });
    it('retains an installed direct result after invalid structural edits',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState();state.request([material]);const previous=state.renderMaterials([material])[0];
        graph.removeNode('channel');state.request([material]);expect(state.status).toBe('failed');expect(state.renderMaterials([material])[0]).toBe(previous);
    });
    it('keeps missing resources, nonlinear graphs, UV projection and conflicting combined maps on the graph path',()=>{
        const {material,graph}=fixture(),lowering=new SlotTextures();
        material.metallicRoughnessMap=new Texture({width:1,height:1,data:new Uint8Array(4)});expect(lowering.lower(material)).toBeUndefined();material.metallicRoughnessMap=undefined;
        material.uvProjection='triplanar';expect(lowering.lower(material)).toBeUndefined();material.uvProjection='none';
        graph.setInput('image','file');expect(lowering.lower(material)).toBeUndefined();expect(materialSlotPlan(material)).toBeUndefined();
    });
    it('routes bounded scalar images into the alpha channel of a layer slot',()=>{
        const {material,graph}=fixture();graph.setTerminal({specularWeight:{node:'gain'}});
        const result=new SlotTextures().lower(material)!;
        expect(result.specularWeight).toBe(.5);
        expect((result.specularWeightMap!.image as {data:Uint8Array}).data).toEqual(new Uint8Array([32,64,192,192]));
        expect(new MaterialData([result],[],()=>1).bufferData.specularWeightMapIndex).toEqual([0]);
    });
    it('restores authored constants and overridden texture references when a terminal is disconnected',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState();
        const original=new Texture({width:1,height:1,data:new Uint8Array([10,80,30,255])});material.roughnessMap=original;
        state.request([material]);const lowered=state.renderMaterials([material])[0];
        material.specularWeight=.25;
        graph.setNode({id:'uv',category:'texcoord',type:'vector2'}).setNode({id:'color',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}).setTerminal({baseColor:{node:'color'}});
        state.request([material]);expect(state.renderMaterials([material])[0].specularWeight).toBe(.25);const textures=state.textures();expect(textures).toContain(original);expect(textures).toContain(lowered.roughnessMap);
        const base=new MaterialData([lowered],[],()=>1).getBufferArray();
        const roughness=materialLayoutFields().find(field=>field.name==='roughness')!.offset/4;
        const index=materialLayoutFields().find(field=>field.name==='roughnessMapIndex')!.offset/4;
        expect(state.pack(base,textures)[roughness]).toBe(.5);
        state.install(state.requested,state.revision);
        const packed=state.pack(base,textures);expect(packed[roughness]).toBe(Math.fround(.1));expect(packed[index]).toBe(textures.indexOf(original));
    });
    it('retains reachable slot capabilities across zero-gain edits without changing packed values',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState();graph.setTerminal({coatWeight:{node:'gain'}}).setInput('gain','in2',{type:'float',value:0});
        state.request([material]);expect(state.slotCapabilities()[0].coatWeight).toBe(1);expect(state.renderMaterials([material])[0].coatWeight).toBe(0);
        graph.setInput('gain','in2',{type:'float',value:.5});state.request([material]);
        expect(state.slotCapabilities()[0].coatWeight).toBe(1);expect(state.active.key).toBe('');expect(state.renderMaterials([material])[0].coatWeight).toBe(.5);
    });
    it('keeps transmission-medium and glTF roughness conversion contexts on the graph path',()=>{
        const {material,graph}=fixture();
        material.specularAnisotropy=.5;material.specularAnisotropyModel='gltf';
        const lowering=new SlotTextures();expect(lowering.lower(material)).toBeUndefined();
        material.specularAnisotropy=0;graph.setTerminal({transmissionWeight:{node:'gain'}});material.transmissionDepth=1;
        expect(lowering.lower(material)).toBeUndefined();material.thinWalled=true;expect(lowering.lower(material)).toBeDefined();
    });
    it('does not retain direct slots when an emission context forces constant fallback',()=>{
        const {material,graph}=fixture(),state=new MaterialGraphState();state.request([material]);
        material.emissionLuminance=1;graph.setTerminal({emissionLuminance:{node:'gain'}});state.request([material]);
        expect(state.status).toBe('failed');expect(state.renderMaterials([material])[0]).toBe(material);
    });
    it('lowers zero-bias image blends with uniform weights',()=>{
        const {material,graph}=fixture(),lowering=new SlotTextures();
        graph.setNode({id:'gain',category:'mix',type:'float',inputs:{bg:{type:'float',value:0},fg:{type:'float',connection:{node:'channel'}},mix:{type:'float',value:.25}}});
        expect(lowering.lower(material)!.specularRoughness).toBe(.25);
        graph.setNode({id:'gain',category:'mix',type:'float',inputs:{fg:{type:'float',value:0},bg:{type:'float',connection:{node:'channel'}},mix:{type:'float',value:.25}}});
        expect(lowering.lower(material)!.specularRoughness).toBe(.75);
    });
    it('shares source uploads between a direct slot and the retained graph during transitions',()=>{
        const {material,graph,texture}=fixture();graph.setInput('channel','index',{type:'integer',value:1});
        const lower=new SlotTextures().lower(material)!.roughnessMap!;
        expect(lower.image).toBe(texture.image);
        const source=slotTextureSources([texture,lower]);
        expect(planTextureAtlas([texture,lower],[1,1],{textureSource:t=>source(t as Texture)}).stats.sourcePixels).toBe(1);
        expect(planIndependentTextures([texture,lower],4,16).estimatedBytes).toBe(4);
        expect(planTextureAtlas([texture,lower],[1,1]).stats.sourcePixels).toBe(2);
    });
    it('aliases internal samplers over one physical atlas image without changing ordinary packing',()=>{
        const {material,graph}=fixture(),lowering=new SlotTextures(),a=lowering.lower(material)!.roughnessMap!;
        graph.setNode({id:'uv',category:'texcoord',type:'vector2',inputs:{index:{type:'integer',value:1}}});graph.setInput('image','texcoord',{type:'vector2',connection:{node:'uv'}});
        const b=lowering.lower(material)!.roughnessMap!;expect(b).not.toBe(a);expect(b.image).toBe(a.image);
        const ordinary=planTextureAtlas([a,b],[1,1]);const alias=planTextureAtlas([a,b],[1,1],{textureSource:t=>slotTextureSource(t as Texture)});
        expect(ordinary.stats.sourcePixels).toBe(2);expect(alias.stats.sourcePixels).toBe(1);expect(alias.mapInfo.slice(0,4)).toEqual(alias.mapInfo.slice(4));expect(alias.mapUvChannel).toEqual([0,1]);
        expect(alias.pages.flatMap(p=>p.placements)).toHaveLength(1);
    });
});
