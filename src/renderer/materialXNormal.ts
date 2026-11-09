import {materialDirectionFlags} from './materialGraph/specialize.js';

/** Browser-only specialization of ordinary texture slots. A half-integer
 * normal-map index tags MaterialX's world tangent frame without changing the
 * packed material layout; every lookup still truncates to the texture index. */
export function materialXNormalShader(source:string) {
    source=materialDirectionFlags(source);
    const anchors=['fn getMaterial(\n','if (normalMapIndex >= 0) {','if (directionMaterial.anisotropyMapIndex >= 0.0'];
    if(anchors.some(anchor=>!source.includes(anchor)))throw new Error('MaterialX normal slot anchors changed');
    const declaration='fn getMaterial(\n';
    const helper=`fn materialx_normal(si:ptr<function,SurfaceInteraction>) {
  let m=materialsBuffer[(*si).materialIndex];
  if(fract(m.normalMapIndex)<0.25) { return; }
  let index=i32(m.normalMapIndex);
  let value=sampleMap(index,getMapUvSet(index,(*si).uv,(*si).uv1)).rgb;
  var d=value*2.0-1.0;
  if(dot(value,value)==0.0) { d=vec3f(0.0,0.0,1.0); }
  (*si).normal=normalize(normalize((*si).geometryTangent)*d.x*m.normalMapScale.x + normalize((*si).geometryBitangent)*d.y*m.normalMapScale.y + (*si).vertexNormal*d.z);
}
`;
    source=source.replace(declaration,helper+'\n'+declaration);
    // The primary normal changes in world space after the instance transform.
    source=source.replace('if (normalMapIndex >= 0) {','if (normalMapIndex >= 0 && fract(matData.normalMapIndex) < 0.25) {');
    source=source.replace('if (directionMaterial.anisotropyMapIndex >= 0.0', 'if (fract(directionMaterial.normalMapIndex) > 0.25 || directionMaterial.anisotropyMapIndex >= 0.0');
    source=source.replace('(*ma).anisotropyDirectionEnabled = select(0u, 1u, matData.specularAnisotropyRotation != 0.0);', '(*ma).anisotropyDirectionEnabled = select(0u, 1u, matData.specularAnisotropyRotation != 0.0) | select(0u, 2u, fract(matData.normalMapIndex) > 0.25);');
    source=source.replace('(*ma).anisotropyDirectionEnabled = 1u;', '(*ma).anisotropyDirectionEnabled |= 1u;');
    let calls=0;
    source=source.replace(/getMaterial\(([^;\n]+)\.vertexColor\);/g,(match,args:string)=>{
        calls++;
        const si=args.slice(args.lastIndexOf(',')+1).trim();
        return `${match}\nmaterialx_normal(${si==='(*si)'?'si':`&${si}`});`;
    });
    if(!calls)throw new Error('MaterialX normal slot anchors changed');
    return source;
}
