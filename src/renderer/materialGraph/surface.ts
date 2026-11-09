import type {MaterialGraphNode as Node, MaterialGraphInput as Input, MaterialGraphType as Type} from '../../scene/MaterialGraph.js';
import type {GraphType} from './types.js';
/** MaterialX surface boundary defaults shared by XML and USD ingestion. */
export function materialXSurfaceInputs(gltf:boolean) {
    const mapping:Record<string,[string,GraphType,number|number[]|undefined]>={
            baseColor:[gltf?'base_color':'diffuseColor','color3',gltf?[1,1,1]:[0.18,0.18,0.18]],baseMetalness:[gltf?'metallic':'metallic','float',gltf?1:0],
            specularRoughness:['roughness','float',gltf?1:0.5],specularIor:['ior','float',1.5],coatWeight:[gltf?'clearcoat':'clearcoat','float',0],coatRoughness:[gltf?'clearcoat_roughness':'clearcoatRoughness','float',gltf?0:0.01],
            opacity:[gltf?'alpha':'opacity','float',1],emissionColor:[gltf?'emissive':'emissiveColor','color3',[0,0,0]],normal:['normal','vector3',undefined]
        };
    if(gltf)Object.assign(mapping,{specularColor:['specular_color','color3',[1,1,1]],specularWeight:['specular','float',1],transmissionWeight:['transmission','float',0],thinFilmWeight:['iridescence','float',0],thinFilmIor:['iridescence_ior','float',1.3],fuzzColor:['sheen_color','color3',[0,0,0]],fuzzRoughness:['sheen_roughness','float',0]});
    return mapping;
}

// A lobe's varying inputs have no effect only when its weight folds to zero.
export const materialXInactiveLobes: Record<string, string[]> = {
    subsurfaceWeight: ['subsurfaceColor', 'subsurfaceRadius', 'subsurfaceRadiusScale', 'subsurfaceAnisotropy']
};
export const materialXInactiveImageInputs: Record<string, string | number> = {
    layer: '', framerange: '', frameoffset: 0, frameendaction: 'constant'
};

// MaterialX 1.39.4 Version.cpp upgrade from 1.38; see THIRD_PARTY_NOTICES.md.
const literal=(type:Type,value:Input['value']):Input=>({type,value});
export function upgradeMaterialXNormalmap(node:Node):Node[]{
    const inputs={...node.inputs},space=inputs.space;
    delete inputs.space;
    if(!space?.connection&&space?.value==='object'){
        const decode=`${node.id}/decode`,bias=`${node.id}/bias`;
        return [{id:decode,category:'multiply',type:'vector3',inputs:{...(inputs.in?{in1:inputs.in}:{}),in2:literal('float',2)}},
            {id:bias,category:'subtract',type:'vector3',inputs:{in1:{type:'vector3',connection:{node:decode}},in2:literal('float',1)}},
            {...node,category:'normalize',inputs:{in:{type:'vector3',connection:{node:bias}}}}];
    }
    if((inputs.normal||inputs.tangent)&&!inputs.bitangent){
        const cross=`${node.id}/cross`,unit=`${node.id}/bitangent`;
        inputs.bitangent={type:'vector3',connection:{node:unit}};
        return [{id:cross,category:'crossproduct',type:'vector3',inputs:{...(inputs.normal?{in1:inputs.normal}:{}),...(inputs.tangent?{in2:inputs.tangent}:{})}},
            {id:unit,category:'normalize',type:'vector3',inputs:{in:{type:'vector3',connection:{node:cross}}}}, {...node,inputs}];
    }
    return [{...node,inputs}];
}
