/** Readers share word offsets with compactVertices; legacy hosts keep vec4-slot offsets. */
export function vertexAttributeReaders(compact: boolean, frames: boolean) {
  if (!compact) return /* wgsl */ `
fn vertexPosition(i:i32)->vec3f {return attrBuffers[i*ATTR_STRIDE+POSITION_OFF].xyz;}
fn vertexNormal(i:i32)->vec3f {return attrBuffers[i*ATTR_STRIDE+NORMAL_OFF].xyz;}
fn vertexUv(i:i32)->vec2f {return attrBuffers[i*ATTR_STRIDE+UV_OFF].xy;}
fn vertexUv1(i:i32)->vec2f {return attrBuffers[i*ATTR_STRIDE+UV1_OFF].xy;}
fn vertexColor(i:i32)->vec3f {return attrBuffers[i*ATTR_STRIDE+COLOR_OFF].xyz;}
fn vertexTangent(i:i32)->vec4f {return ${frames ? 'attrBuffers[i*ATTR_STRIDE+TANGENT_OFF]' : 'vec4f(attrBuffers[i*ATTR_STRIDE+TANGENT_OFF],0.0)'};}
`;
  return /* wgsl */ `
fn octDirection(a:i32,b:i32,maximum:f32)->vec3f {
  if (a == -i32(maximum)-1 && b == -i32(maximum)-1) {return vec3f(0.0);}
  var v=vec3f(f32(a)/maximum,f32(b)/maximum,0.0);
  v.z=1.0-abs(v.x)-abs(v.y);
  if(v.z<0.0) {v=vec3f((vec2f(1.0)-abs(v.yx))*select(vec2f(-1.0),vec2f(1.0),v.xy>=vec2f(0.0)),v.z);}
  return normalize(v);
}
fn vertexPosition(i:i32)->vec3f {
  let o=i*ATTR_STRIDE+POSITION_OFF;
  return bitcast<vec3f>(vec3u(attrBuffers[o],attrBuffers[o+1],attrBuffers[o+2]));
}
fn vertexNormal(i:i32)->vec3f {
  let o=i*ATTR_STRIDE+NORMAL_OFF;
  if(NORMAL_FLOAT) {return bitcast<vec3f>(vec3u(attrBuffers[o],attrBuffers[o+1],attrBuffers[o+2]));}
  let w=attrBuffers[o];
  return octDirection(i32(w<<16u)>>16,i32(w)>>16,32767.0);
}
fn vertexUv(i:i32)->vec2f {
  if(!HAS_VERTEX_UV) {return vec2f(0.0);}
  let o=i*ATTR_STRIDE+UV_OFF;
  return bitcast<vec2f>(vec2u(attrBuffers[o],attrBuffers[o+1]));
}
fn vertexUv1(i:i32)->vec2f {
  if(!HAS_VERTEX_UV) {return vec2f(0.0);}
  let o=i*ATTR_STRIDE+UV1_OFF;
  return bitcast<vec2f>(vec2u(attrBuffers[o],attrBuffers[o+1]));
}
fn vertexColor(i:i32)->vec3f {
  if(!USE_VERTEX_COLOR) {return vec3f(1.0);}
  let o=i*ATTR_STRIDE+COLOR_OFF;
  if(COLOR_FLOAT) {return bitcast<vec3f>(vec3u(attrBuffers[o],attrBuffers[o+1],attrBuffers[o+2]));}
  return unpack4x8unorm(attrBuffers[o]).xyz;
}
fn vertexTangent(i:i32)->vec4f {
  if(!HAS_VERTEX_TANGENT) {return vec4f(0.0);}
  let w=attrBuffers[i*ATTR_STRIDE+TANGENT_OFF];
  let direction=octDirection(i32(w<<17u)>>17,i32(w<<2u)>>17,16383.0);
  let signs=array<f32,4>(0.0,1.0,-1.0,2.0);
  return vec4f(direction,signs[w>>30u]);
}
fn triangleMaterial(fallback:i32,record:i32)->i32 {
  if(!HAS_TRIANGLE_MATERIAL) {return fallback;}
  let material=attrBuffers[MATERIALINDEX_OFF+record];
  if(material==0u) {return fallback;}
  return i32(material-1u);
}
`;
}
