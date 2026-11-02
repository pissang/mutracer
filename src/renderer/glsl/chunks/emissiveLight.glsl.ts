export default /* glsl */ `
vec4 emissiveTexel(int i) { return fetchData(emissiveLightData,i,emissiveLightColumns); }
void sampleEmissiveSceneLight(vec3 x, vec3 rnd, inout LightSampleRec ls) {
  ls.pdf=0.0;ls.isDelta=false;ls.sourceType=0;ls.sourceIndex=-1;
  if(emissiveChoiceCount<=0) return;
  float scaled=rnd.z*float(emissiveChoiceCount);int column=min(int(scaled),emissiveChoiceCount-1);
  vec4 first=emissiveTexel(emissiveChoiceOffset+column);
  int chosen=fract(scaled)<first.x?column:floatBitsToInt(first.y);
  vec4 choice=emissiveTexel(emissiveChoiceOffset+chosen);int kind=floatBitsToInt(choice.z),index=floatBitsToInt(choice.w);
  float pmf=emissiveTexel(emissivePmfOffset+chosen).x;
  if(kind==1) {
#ifdef USE_ENVMAP
    sampleEnvLight(rnd.xy,ls);ls.pdf*=pmf;
#endif
  } else if(kind==2) {
#ifdef NUM_LIGHTS
    Light light=fetchLight(index);
    
    ls.sourceType=2;ls.sourceIndex=index;
    sampleAnalyticLight(light,x,rnd.xy,ls);ls.pdf*=pmf;
#endif
  } else if(kind==3) {
    vec4 a=emissiveTexel(index*6),b=emissiveTexel(index*6+1),c=emissiveTexel(index*6+2);
    vec4 d=emissiveTexel(index*6+3),e=emissiveTexel(index*6+4),f=emissiveTexel(index*6+5);
    float u=sqrt(rnd.x);vec3 bary=vec3(1.0-u,u*(1.0-rnd.y),u*rnd.y);
    vec3 p=a.xyz*bary.x+b.xyz*bary.y+c.xyz*bary.z;
    ls.normal=normalize(cross(b.xyz-a.xyz,c.xyz-a.xyz));ls.direction=normalize(p-x);ls.dist=distance(x,p);
    float cosine=dot(ls.normal,-ls.direction);if(cosine<=0.0) return;
    OpenPbrResolvedMaterial m;
    getMaterial(m,int(c.w),bary.x*d.xy+bary.y*d.zw+bary.z*e.xy,bary.x*e.zw+bary.y*f.xy+bary.z*f.zw,0,vec3(1.0));
    ls.emission=m.emission;ls.pdf=pmf*ls.dist*ls.dist/max(b.w*cosine,1e-8);ls.sourceType=1;ls.sourceIndex=index;
  }
}
`;
