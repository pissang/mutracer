/** World-space normal sampling for internally tagged MaterialX texture slots. */
export function materialXNormalDeclarations() {
    return `fn materialx_normal(si:ptr<function,SurfaceInteraction>) {
  let m=materialsBuffer[(*si).materialIndex];
  if(fract(m.normalMapIndex)<0.25) { return; }
  let index=i32(m.normalMapIndex);
  let value=sampleMap(index,getMapUvSet(index,(*si).uv,(*si).uv1)).rgb;
  var d=value*2.0-1.0;
  if(dot(value,value)==0.0) { d=vec3f(0.0,0.0,1.0); }
  (*si).normal=normalize(normalize((*si).geometryTangent)*d.x*m.normalMapScale.x + normalize((*si).geometryBitangent)*d.y*m.normalMapScale.y + (*si).vertexNormal*d.z);
}
`;
}
