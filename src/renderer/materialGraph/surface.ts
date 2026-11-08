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
