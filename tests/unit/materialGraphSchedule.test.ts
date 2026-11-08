import {describe,expect,it} from 'vitest';
import fixture from '../fixtures/display-schedule.json';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
function graph(value:number,structure=false,invalid=false) {
    return new MaterialGraph({nodes:[{id:'value',category:invalid?'unknown':'constant',type:'color3',inputs:{value:{type:'color3',value:[value,value,value]}}},
        ...(structure?[{id:'multiply',category:'multiply',type:'color3' as const,inputs:{in1:{type:'color3' as const,connection:{node:'value'}},in2:{type:'float' as const,value:1}}}]:[])],terminal:{emissionColor:{node:structure?'multiply':'value'}}});
}
describe('material graph preparation schedule',()=>{
    it.each(['webgpu','webgl'] as const)('keeps the installed %s graph sampling and installs only the newest request',backend=>{
        const material=new OpenPBRMaterial({unlit:true,emissionLuminance:1,graph:graph(.2)}),state=new MaterialGraphState(backend);
        state.request([material]);state.install(state.requested,state.revision);
        let obsolete=state.requested,obsoleteRevision=0;const sampled:number[]=[];
        for(const event of fixture.materialGraphPreparation.events) {
            if(event==='sample')sampled.push(Number(state.active.graphs[0]!.parameters[0] instanceof Array?(state.active.graphs[0]!.parameters[0] as number[])[0]:NaN));
            else if(event==='request-structure') {material.graph=graph(.4,true);state.request([material]);obsolete=state.requested;obsoleteRevision=state.revision;}
            else if(event==='request-newer') {material.graph=graph(.8,true);state.request([material]);}
            else if(event==='complete-obsolete')expect(state.install(obsolete,obsoleteRevision)).toBe(false);
            else if(event==='complete-current')expect(state.install(state.requested,state.revision)).toBe(true);
            else if(event==='request-invalid') {material.graph=graph(.9,true,true);state.request([material]);expect(state.status).toBe('failed');}
        }
        expect(sampled).toEqual(fixture.materialGraphPreparation.sampledValues);
    });
    it.each(['webgpu','webgl'] as const)('retains the %s graph after pipeline failure',backend=>{
        const material=new OpenPBRMaterial({unlit:true,emissionLuminance:1,graph:graph(.2)}),state=new MaterialGraphState(backend);
        state.request([material]);state.install(state.requested,state.revision);const sampled:number[]=[];
        for(const event of fixture.materialGraphCompilationFailure.events) {
            if(event==='sample')sampled.push((state.active.graphs[0]!.parameters[0] as number[])[0]);
            else if(event==='request'){material.graph=graph(.9,true);state.request([material]);}
            else {state.fail(state.revision,new Error('Pipeline compilation failed'));expect(state.status).toBe('failed');}
        }
        expect(sampled).toEqual(fixture.materialGraphCompilationFailure.sampledValues);
    });

});
