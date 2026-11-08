import {describe,expect,it} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {generateGraphIR} from '../../src/renderer/materialGraph/generate.js';
import {validateGraphIR} from '../../src/renderer/materialGraph/validate.js';
import {GraphSource, graphPorts} from '../../src/renderer/materialGraph/ir.js';
import {materialGraphFixtures} from '../../native/validation/material-graph-fixtures.js';

function graph() {
    return flattenGraph(normalizeGraph(new MaterialGraph({nodes:[
        {id:'uv',category:'texcoord',type:'vector2'},
        {id:'color',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}
    ],terminal:{baseColor:{node:'color'}}})));
}
describe('portable material graph IR',()=>{
    it('validates and replays every supported category/type through flat data',()=>{
        for(const fixture of materialGraphFixtures()) {
            const ir=flattenGraph(fixture.graph);
            expect(validateGraphIR(ir),fixture.label).toEqual([]);
            expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
            for(const backend of ['webgpu','webgl'] as const) {
                const generated=generateGraphIR(ir,backend);
                expect(generated.parameters.length%4).toBe(0);
                expect(generated.foldedWidths.length).toBe(generated.foldedNodes);
            }
        }
    });
    it('keeps parameter edits out of structure and code',()=>{
        const a=graph(),b=structuredClone(a);
        b.parameters[0]=1;
        expect(validateGraphIR(b)).toEqual([]);
        expect(generateGraphIR(a,'webgpu').source).toBe(generateGraphIR(b,'webgpu').source);
        expect(generateGraphIR(a,'webgpu').parameters).not.toEqual(generateGraphIR(b,'webgpu').parameters);
    });
    it('rejects incompatible versions, cyclic edges and mistyped terminals before emission',()=>{
        const cases=[graph(),graph(),graph(),graph()];
        cases[0].version++;
        cases[1].nodes[1]++;
        cases[2].inputs[7]=GraphSource.Node; cases[2].inputs[8]=1;
        cases[3].terminal[1]=0;
        for(const ir of cases) {
            expect(validateGraphIR(ir).length).toBeGreaterThan(0);
            expect(()=>generateGraphIR(ir,'webgpu')).toThrow();
        }
    });
    it('locates invalid parameter controls and missing normalized inputs',()=>{
        const ir=graph();ir.parameters[0]=2;
        expect(validateGraphIR(ir)).toContainEqual(expect.objectContaining({code:'unsupported-uv',node:0,port:graphPorts.indexOf('index')}));
        const missing=graph();missing.inputs.splice(0,5);missing.nodes[4]=0;missing.nodes[8]=0;
        expect(validateGraphIR(missing)).toContainEqual(expect.objectContaining({code:'missing-input',node:0,port:graphPorts.indexOf('index')}));
    });
    it('rejects malformed record indices without accessing invalid nodes',()=>{
        for(const table of ['nodes','inputs','terminal'] as const) for(let i=0;i<graph()[table].length;i++) for(const value of [-100,9999,0.5,NaN]) {
            const ir=graph();ir[table][i]=value;
            expect(()=>validateGraphIR(ir),`${table}[${i}]=${value}`).not.toThrow();
            expect(validateGraphIR(ir).length,`${table}[${i}]=${value}`).toBeGreaterThan(0);
        }
    });
});
