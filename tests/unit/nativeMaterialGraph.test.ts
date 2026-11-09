import {describe,it,expect} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import MaterialData from '../../src/renderer/MaterialData.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import {materialGraphFixtures} from '../../native/validation/material-graph-fixtures.js';
import {NativeMaterial,refreshNativeGraph,packNativeGraphs,nativeGraphPlan,inheritNativeGraph,seedGraphFallbacks,attachGraphFallbacks} from '../../native/src/material-graph.js';

function raw(graph:ReturnType<typeof normalizeGraph>,unlit=true) {
    const material=new NativeMaterial({unlit});material.aovId=42;
    material.graph={ir:flattenGraph(graph),textures:[],authorIds:graph.nodes.map(n=>n.id)};
    refreshNativeGraph(material);return material;
}
function author() {return new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'c',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{baseColor:{node:'c'}}});}
describe('native material graph preparation',()=>{
    it('packs the browser parameter and topology contract for every supported node/type',()=>{
        for(const {label,graph} of materialGraphFixtures()) {
            const native=raw(graph),web=new OpenPBRMaterial({unlit:true});
            const state=new MaterialGraphState();
            const plan={key:graph.key,materials:[web],graphs:[graph],structures:[graph]};
            state.requested=plan;state.active=plan;
            // request initializes packing's material list; install the normalized fixture afterwards.
            state.request([web]);state.active=plan;
            const a=new MaterialData([native],[],()=>1).getBufferArray(),b=new MaterialData([web],[],()=>1).getBufferArray();
            expect(native.graphDiagnostics,label).toEqual([]);
            expect(packNativeGraphs(a,[native],[]),label).toEqual(state.pack(b,[]));
        }
    });
    it('keeps the exact no-graph buffer allocation',()=>{
        const material=new NativeMaterial(),buffer=new MaterialData([material],[],()=>1).getBufferArray();
        expect(packNativeGraphs(buffer,[material],[])).toBe(buffer);
    });
    it('retains prior graph data by stable material identity after a validation failure',()=>{
        const first=raw(normalizeGraph(author()));
        seedGraphFallbacks(77,[first]);
        const next=raw(normalizeGraph(author()));next.graph!.ir.nodes[0]=999;
        attachGraphFallbacks(77,[next]);
        expect(next.graphDiagnostics).toContainEqual(expect.objectContaining({code:'unsupported-node',materialId:42,node:'uv'}));
        expect(next.effectiveGraph).toBe(first.effectiveGraph);
        const different=raw(normalizeGraph(author()));different.aovId=43;different.graph!.ir.nodes[0]=999;
        attachGraphFallbacks(77,[different]);
        expect(different.effectiveGraph).toBeUndefined();
    });
    it('rechecks retained emission and opacity contexts and forces constants when incompatible',()=>{
        const emitter=normalizeGraph(new MaterialGraph({nodes:[{id:'emission',category:'constant',type:'color3'}],terminal:{emissionColor:{node:'emission'}}}));
        const first=raw(emitter);expect(first.effectiveGraph).toBeDefined();
        const next=raw(emitter,false);inheritNativeGraph(next,first);
        expect(next.effectiveGraph).toBeUndefined();
        expect(next.graphDiagnostics).toContainEqual(expect.objectContaining({code:'unsupported-emission-graph',node:'emission',port:'emissionColor'}));
        const graph=normalizeGraph(new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'x',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{opacity:{node:'x'}}}));
        const opacity=raw(graph);opacity.uvProjection='triplanar';refreshNativeGraph(opacity);
        expect(opacity.effectiveGraph).toBeUndefined();expect(opacity.graphDiagnostics[0].code).toBe('unsupported-opacity-projection');
    });
    it('does not add a shader structure for parameter changes',()=>{
        const material=raw(normalizeGraph(author()));const key=nativeGraphPlan([material]).key;
        material.graph!.ir.parameters[0]=1;refreshNativeGraph(material);
        expect(nativeGraphPlan([material]).key).toBe(key);
    });
});
