import {LIGHT_SHADER_CAPABILITIES} from '../shaderCapabilities.js';
import type Geometry from '../../scene/Geometry.js';
import type {GraphPlan} from './state.js';

/** Graph parameters can change without a new structure. Select capabilities
 * from reachable terminals/context, never from a parameter's current value. */
export function materialGraphConstants(constants:Record<string,boolean|number>,plan:GraphPlan,geometry?:Geometry) {
    const result={...constants};
    if(!plan.key)return result;
    // A variant reused across structure edits keeps the features it was compiled with.
    const structures=plan.featureStructures??plan.structures;
    const terminal=(...names:string[])=>structures.some(g=>names.some(name=>name in g.terminal));
    const frames=terminal('normal','specularAnisotropy','coatAnisotropy') ||
        structures.some(g=>g.nodes.some(n=>['tangent','bitangent'].includes(n.category)||Object.values(n.inputs).some(i=>i.geometry==='tangent'||i.geometry==='bitangent'))) ||
        (plan.materials??[]).some((m,i)=>plan.graphs[i]&&(m.specularAnisotropy>0||m.coatAnisotropy>0));
    if(frames){
        result.USE_ANISOTROPY_DIRECTIONS=true;
        result.USE_TANGENT=geometry?.tangent!=null;
    }
    if(terminal('normal'))result.USE_COAT_NORMAL_FRAMES=true;
    // texcoord.index is editable data, so both UV sets must remain available.
    // Compact WebGPU geometry has no UV metadata on its layout facade; the
    // packed UV1 offset aliases UV0 when a mesh has no secondary coordinates.
    if(structures.some(g=>g.nodes.some(n=>n.category==='texcoord')))result.USE_UV1=true;
    if(terminal('emissionColor','emissionLuminance'))result.LIGHT_CAPABILITIES=Number(result.LIGHT_CAPABILITIES ?? 0)|LIGHT_SHADER_CAPABILITIES.emissive;
    if(terminal('opacity')){result.HAS_ALPHA=true;result.HAS_ALPHA_MASK=true;result.HAS_ALPHA_BLEND=true;}
    if(terminal('coatWeight'))result.HAS_COAT=true;
    if(terminal('fuzzWeight'))result.HAS_FUZZ=true;
    if(terminal('thinFilmWeight'))result.HAS_THIN_FILM=true;
    result.MATERIAL_CAPABILITIES=Number(result.MATERIAL_CAPABILITIES) |
        (terminal('transmissionWeight')?1:0) | (terminal('baseMetalness')?2:0);
    return result;
}
