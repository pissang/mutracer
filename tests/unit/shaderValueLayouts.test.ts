import {describe,it,expect} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {materialGraphShaderIR} from '../../src/renderer/materialGraph/specialize.js';
import {rayTrace,gpu} from './shaderSourceFormattingFixture';

// WGSL value layouts are compiler inputs, not Metal register counts. A change
// requires the GPU benchmark described in the linked contributor note.
const layouts={
    plain:{OpenPbrResolvedMaterial:[41,272,2],OpenPbrPreparedBsdf:[22,528,0],SurfaceInteraction:[21,192,2],Path:[10,96,5]},
    frames:{OpenPbrResolvedMaterial:[51,400,4],OpenPbrPreparedBsdf:[25,736,1],SurfaceInteraction:[26,272,2],Path:[10,96,5]}
};
const graph=flattenGraph(normalizeGraph(new MaterialGraph({nodes:[
    {id:'uv',category:'texcoord',type:'vector2'},
    {id:'color',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}
],terminal:{baseColor:{node:'color'}}})));

// webgpu-utils 1.11 reports zero-sized bools because they are not host-shareable.
// For value-layout reflection only, use u32's identical WGSL size/alignment (4/4):
// https://gpuweb.github.io/gpuweb/wgsl/#alignment-and-size . Keep the real types
// in a separate reflection so changing bool/u32 still fails the contract.
function valueDefinitions(source:string) {
    return makeShaderDataDefinitions(source.replace(/struct\s+\w+\s*\{[^}]*\}/g,block=>block.replace(/\bbool\b/g,'u32')));
}
describe('megakernel value-layout contracts',()=>{
    it('accounts for boolean size and alignment in nested value types',()=>{
        gpu();const structs=valueDefinitions('struct Flag { value:bool, }; struct Mixed { flag:Flag, normal:vec3f, };').structs;
        expect(structs.Flag.size).toBe(4);expect(structs.Mixed.fields.normal.offset).toBe(16);expect(structs.Mixed.size).toBe(32);
    });
    for(const frames of [false,true])for(const sceneAlpha of [false,true])for(const compactVertices of [false,true])for(const specialized of [false,true]) {
        it(`keeps value layouts (frames=${frames}, alpha=${sceneAlpha}, compact=${compactVertices}, graph=${specialized})`,()=>{
            gpu();
            const generated=rayTrace({hasDisplacement:false,hasAnisotropyDirections:frames,hasCoatNormals:frames,hasAlpha:true,hasSceneAlpha:sceneAlpha,compactVertices,materialHooks:specialized?materialGraphShaderIR([graph],frames):{}});
            const original=makeShaderDataDefinitions(generated),definitions=valueDefinitions(generated);
            for(const [name,expected] of Object.entries(frames?layouts.frames:layouts.plain)) {
                const struct=definitions.structs[name];
                const bools=Object.values(original.structs[name].fields).filter(field=>'type' in field.type&&field.type.type==='bool').length;
                const contract=expected.slice();if(!sceneAlpha&&name==='OpenPbrResolvedMaterial')contract[0]--;if(specialized&&frames&&name==='OpenPbrResolvedMaterial')contract[2]--;
                expect([Object.keys(struct.fields).length,struct.size,bools],`${name}: review docs/technical/megakernel-value-layouts.md and run the GPU benchmark before changing this contract`).toEqual(contract);
            }
        });
    }
});
