import {INSTANCE_VEC4_STRIDE} from '../../bvhAccel.js';
import {createShaderMixin,Shader} from '../../shader.js';
// Independent GLSL implementation of the single-interface implicit map in mnee.wgsl.ts.
export function createMneeGlsl(debug = false,sms=false,seeds=4,damping=false,maxDepth=20,roulette=false) { return createShaderMixin({uniforms:{
  mneeSeedOffset:Shader.uniform('int'),mneeSeedCount:Shader.uniform('int'),
  mneeLightData:Shader.uniform('sampler2D'),mneeLightColumns:Shader.uniform('int'),
  mneeChoiceOffset:Shader.uniform('int'),mneeChoiceCount:Shader.uniform('int'),mneePmfOffset:Shader.uniform('int')
},main: /* glsl */ `
${debug ? 'float mneeCounters[21];vec3 mneeTrace[10];bool mneeTraceEnabled;' : ''}
vec3 mneeFail(int reason){${debug ? 'mneeCounters[reason]+=1.0;if(mneeTraceEnabled)mneeTrace[7].x=float(reason);' : ''}return vec3(0.0);}
vec4 mneeTexel(int i) { return fetchData(mneeLightData,i,mneeLightColumns); }
void sampleMneeLight(vec3 x, vec3 rnd, inout LightSampleRec ls) {
  ls.pdf=0.0;ls.isDelta=false;ls.sourceType=0;ls.sourceIndex=-1;
  if(mneeChoiceCount<=0) return;
  float scaled=rnd.z*float(mneeChoiceCount);int column=min(int(scaled),mneeChoiceCount-1);
  vec4 first=mneeTexel(mneeChoiceOffset+column);
  int chosen=fract(scaled)<first.x?column:floatBitsToInt(first.y);
  vec4 choice=mneeTexel(mneeChoiceOffset+chosen);int kind=floatBitsToInt(choice.z),index=floatBitsToInt(choice.w);
  float pmf=mneeTexel(mneePmfOffset+chosen).x;
  if(kind==2) {
#ifdef NUM_LIGHTS
    Light light=fetchLight(index);
    ls.sourceType=2;ls.sourceIndex=index;
    sampleAnalyticLight(light,x,rnd.xy,ls);ls.pdf*=pmf;
#endif
  } else if(kind==3) {
    vec4 a=mneeTexel(index*6),b=mneeTexel(index*6+1),c=mneeTexel(index*6+2);
    vec4 d=mneeTexel(index*6+3),e=mneeTexel(index*6+4),f=mneeTexel(index*6+5);
    float u=sqrt(rnd.x);vec3 bary=vec3(1.0-u,u*(1.0-rnd.y),u*rnd.y);
    vec3 p=a.xyz*bary.x+b.xyz*bary.y+c.xyz*bary.z;
    ls.normal=normalize(cross(b.xyz-a.xyz,c.xyz-a.xyz));ls.direction=normalize(p-x);ls.dist=distance(x,p);
    // Defer one-sided emission to the solved interface-to-light direction.
    OpenPbrResolvedMaterial m;
    getMaterial(m,int(c.w),bary.x*d.xy+bary.y*d.zw+bary.z*e.xy,bary.x*e.zw+bary.y*f.xy+bary.z*f.zw,0,vec3(1.0));
    ls.emission=m.emission;ls.pdf=pmf/b.w;ls.sourceType=1;ls.sourceIndex=index;
  }
}
struct MneeFrame { vec3 origin;vec3 du;vec3 dv;vec3 nu;vec3 nv;vec3 t;vec3 b; };
MneeFrame mneeFrame(SurfaceInteraction si) {
  int off=si.instanceIndex*${INSTANCE_VEC4_STRIDE};
  ivec3 index=floatBitsToInt(fetchBVH(si.triangleIndex).xyz)+ivec3(floatBitsToInt(fetchIns(off).y));
  mat4 l2w=mat4(fetchIns(off+5),fetchIns(off+6),fetchIns(off+7),fetchIns(off+8));
  mat4 w2l=mat4(fetchIns(off+1),fetchIns(off+2),fetchIns(off+3),fetchIns(off+4));
  mat3 nm=transpose(mat3(w2l));
  vec3 p0=fetchData(positionBuffer,index.x,vertexColumns).xyz,p1=fetchData(positionBuffer,index.y,vertexColumns).xyz,p2=fetchData(positionBuffer,index.z,vertexColumns).xyz;
  vec3 n0=nm*fetchData(normalBuffer,index.x,vertexColumns).xyz,n1=nm*fetchData(normalBuffer,index.y,vertexColumns).xyz,n2=nm*fetchData(normalBuffer,index.z,vertexColumns).xyz;
  vec3 u=p1-p0,v=p2-p0,local=(w2l*vec4(si.position,1.0)).xyz-p0;
  float det=dot(u,u)*dot(v,v)-dot(u,v)*dot(u,v);
  float bu=(dot(local,u)*dot(v,v)-dot(local,v)*dot(u,v))/det,bv=(dot(local,v)*dot(u,u)-dot(local,u)*dot(u,v))/det;
  vec3 rawN=n0*(1.0-bu-bv)+n1*bu+n2*bv,n=normalize(rawN);
  MneeFrame f;f.origin=(l2w*vec4(p0,1.0)).xyz;f.du=(l2w*vec4(u,0.0)).xyz;f.dv=(l2w*vec4(v,0.0)).xyz;
  f.nu=(n1-n0-n*dot(n,n1-n0))/max(length(rawN),1e-8);f.nv=(n2-n0-n*dot(n,n2-n0))/max(length(rawN),1e-8);
  sampling_orthonormal_basis(si.normal,f.t,f.b);return f;
}
vec2 mneeProject(vec3 v,MneeFrame f){return vec2(dot(v,f.t),dot(v,f.b));}
vec2 mneeColumn(vec3 dp,vec3 dn,vec3 wi,vec3 wo,float ri,float ro,float eta,vec3 n,MneeFrame f){
  vec3 dq=-(dp-wo*dot(wo,dp))/ro-eta*(dp-wi*dot(wi,dp))/ri;
  return mneeProject(dq-dot(wo+eta*wi,n)*dn,f);
}
mat2 mneeMatrix(SurfaceInteraction si,vec3 x,vec3 y,float eta,MneeFrame f,bool directional){
  vec3 wi=normalize(x-si.position),wo=normalize(y-si.position);
  return mat2(mneeColumn(f.du,f.nu,wi,wo,distance(x,si.position),(directional?INF:distance(y,si.position)),eta,si.normal,f),mneeColumn(f.dv,f.nv,wi,wo,distance(x,si.position),(directional?INF:distance(y,si.position)),eta,si.normal,f));
}
vec2 mneeSolve2(mat2 j,vec2 v){return vec2(j[1].y*v.x-j[1].x*v.y,j[0].x*v.y-j[0].y*v.x)/determinant(j);}
bool mneeDiffuse(OpenPbrResolvedMaterial m){return m.baseWeight*(1.0-m.baseMetalness)*(1.0-m.transmissionWeight)>0.0&&m.subsurfaceWeight==0.0;}
vec3 mneeSeed(vec3 receiver,int seed){
 vec3 rnd=vec3(sample2D(causticDim(100u+uint(seed)*2u)),sample1D(causticDim(101u+uint(seed)*2u)));
 int low=0,high=mneeSeedCount-1;
 for(int step=0;step<32;step++){if(low>=high)break;int middle=(low+high)/2;if(mneeTexel(mneeSeedOffset+middle*3).w<rnd.z)low=middle+1;else high=middle;}
 int offset=mneeSeedOffset+low*3;vec3 a=mneeTexel(offset).xyz,b=mneeTexel(offset+1).xyz,c=mneeTexel(offset+2).xyz;
 float u=sqrt(rnd.x);return a*(1.0-u)+b*u*(1.0-rnd.y)+c*u*rnd.y;
}
vec3 mneeSolve(SurfaceInteraction receiver,OpenPbrPreparedBsdf prepared,LightSampleRec ls,int seed,out vec3 solution){
  solution=vec3(INF);
  if(samplingBounce>${maxDepth}u||!mneeDiffuse(prepared.material))return vec3(0.0);
${debug ? '  mneeCounters[0]+=1.0;mneeTraceEnabled=seed==0;if(mneeTraceEnabled){mneeTrace[0]=receiver.position;mneeTrace[5]=receiver.position+ls.direction*ls.dist;mneeTrace[9]=vec3(float(ls.sourceType),ls.pdf,ls.normal.y);}' : ''}
  if(ls.sourceType==0||ls.pdf<=0.0)return mneeFail(1);
  bool directional=false,point=false;
#ifdef NUM_LIGHTS
  if(ls.sourceType==2){Light light=fetchLight(ls.sourceIndex);directional=int(light.type)==DIRECTIONAL_LIGHT;point=ls.isDelta&&!directional;}
#endif
  vec3 x=receiver.position,y=x+ls.direction*(directional?1e8:ls.dist);
  float pdfA=ls.pdf;if(ls.sourceType!=1&&!directional&&!point)pdfA*=abs(dot(ls.normal,-ls.direction))/(ls.dist*ls.dist);if(pdfA<=0.0)return mneeFail(1);
  vec3 direction=ls.direction;if(seed>0&&mneeSeedCount>0)direction=normalize(mneeSeed(x,seed)-x);
  Ray ray;initRay(ray,x+EPS*direction,direction);SurfaceInteraction si;si.triangleIndex=-1;${debug?'mneeCounters[12]+=1.0;':''}intersectScene(ray,si,true);
  if(!si.hit||(seed==0&&!directional&&distance(x,si.position)>=ls.dist-EPS))return mneeFail(2);
  OpenPbrResolvedMaterial material;float eta=1.0,dielectricEta=1.0;bool reflection=false;
  for(int iteration=0;iteration<${damping?20:10};iteration++){
    getMaterial(material,si.materialIndex,si.uv,si.uv1,si.instanceIndex,si.vertexColor);
    reflection=dot(x-si.position,si.faceNormal)*dot(y-si.position,si.faceNormal)>0.0;
    ${debug ? 'if(iteration==0){mneeCounters[15]+=1.0;if(reflection)mneeCounters[16]+=1.0;if(!isCausticSpecular(material))mneeCounters[17]+=1.0;if(mneeTraceEnabled){mneeTrace[0]=x;mneeTrace[1]=si.position;mneeTrace[2]=si.normal;mneeTrace[3]=si.faceNormal;mneeTrace[4]=vec3(material.specularIor,reflection?1.0:0.0,float(si.instanceIndex));mneeTrace[5]=y;}}' : ''}
    if((reflection&&!isCausticR(material))||(!reflection&&!isCausticT(material))){${debug?'if(iteration==0)mneeCounters[18]+=1.0;else mneeCounters[19]+=1.0;':''}return mneeFail(3);}
    float ior=material.specularIor;
    if(pathWavelength>0.0)ior=sampling_cauchy_ior(pathWavelength,ior,material.transmissionDispersionScale,material.dispersionAbbeNumber);
    dielectricEta=dot(x-si.position,si.faceNormal)>0.0?1.0/ior:ior;eta=reflection?1.0:dielectricEta;
    MneeFrame f=mneeFrame(si);vec3 q=normalize(y-si.position)+eta*normalize(x-si.position);vec2 c=mneeProject(q,f);
${debug?'if(mneeTraceEnabled){mneeTrace[6]=vec3(eta,length(c),float(iteration));mneeTrace[8]=si.position;}':''}
    if(length(c)<1e-5)break;
${debug ? '    mneeCounters[11]+=1.0;' : ''}
    mat2 j=mneeMatrix(si,x,y,eta,f,directional);if(!(abs(determinant(j))>=1e-12))return mneeFail(4);
${damping?/* glsl */ `    vec2 step=mneeSolve2(j,c);vec3 position=si.position;int interfaceInstance=si.instanceIndex,interfaceMaterial=si.materialIndex;float scale=1.0;bool improved=false;
    for(int backtrack=0;backtrack<8;backtrack++){
      vec3 proposal=position-scale*(f.du*step.x+f.dv*step.y),direction=normalize(proposal-x);
      initRay(ray,x+EPS*direction,direction);
${debug?'      mneeCounters[12]+=1.0;':''}
      intersectScene(ray,si,true);
      if(si.hit&&si.instanceIndex==interfaceInstance&&si.materialIndex==interfaceMaterial){
        bool nextReflection=dot(x-si.position,si.faceNormal)*dot(y-si.position,si.faceNormal)>0.0;
        float nextEta=dot(x-si.position,si.faceNormal)>0.0?1.0/ior:ior;
        vec3 nextQ=normalize(y-si.position)+(reflection?1.0:nextEta)*normalize(x-si.position),tangent,bitangent;sampling_orthonormal_basis(si.normal,tangent,bitangent);vec2 nextC=vec2(dot(nextQ,tangent),dot(nextQ,bitangent));
        if(nextReflection==reflection&&length(nextC)<length(c)){improved=true;break;}
      }
      scale*=.5;
    }
    if(!improved)return mneeFail(5);`:/* glsl */ `
    vec2 step=mneeSolve2(j,c);if(!all(lessThan(abs(step),vec2(INF))))return mneeFail(4);
    vec3 proposal=si.position-f.du*step.x-f.dv*step.y;
    if(!all(lessThan(abs(proposal),vec3(INF)))||dot(proposal-x,proposal-x)<1e-16)return mneeFail(5);
    vec3 direction=normalize(proposal-x);initRay(ray,x+EPS*direction,direction);
${debug?'    mneeCounters[12]+=1.0;':''}intersectScene(ray,si,true);if(!si.hit)return mneeFail(5);
`}
  }
  MneeFrame f=mneeFrame(si);vec3 wi=normalize(x-si.position),wo=normalize(y-si.position);
  if(length(mneeProject(wo+eta*wi,f))>1e-4||(dot(wi,si.faceNormal)*dot(wo,si.faceNormal)>0.0)!=reflection)return mneeFail(6);
  vec3 normal=dot(wi,si.normal)>=0.0?si.normal:-si.normal,refracted=reflection?reflect(-wi,normal):refract(-wi,normal,eta);
  if(dot(refracted,refracted)<.5||dot(refracted,wo)<.9999)return mneeFail(7);
  initRay(ray,si.position+EPS*wo,wo);vec3 endpoint=y+EPS*ls.normal;
${debug ? '  mneeCounters[13]+=1.0;' : ''}
  if(intersectSceneShadow(ray,max(distance(ray.o,endpoint)-EPS,0.0),si.triangleIndex)||(!directional&&!point&&dot(ls.normal,-wo)<=0.0))return mneeFail(8);
#ifdef NUM_LIGHTS
  if(ls.sourceType==2){Light light=fetchLight(ls.sourceIndex);if(int(light.type)==RECT_LIGHT&&dot(ls.normal,-wo)<cos(.5*PI*light.spread))return mneeFail(9);}
#endif
  mat2 j=mneeMatrix(si,x,y,eta,f,directional);if(!(abs(determinant(j))>=1e-12))return mneeFail(4);
  vec3 lt,lb;sampling_orthonormal_basis(point?-wo:ls.normal,lt,lb);float r=directional?1.0:distance(y,si.position);
  mat2 b=mat2(mneeProject((lt-wo*dot(wo,lt))/r,f),mneeProject((lb-wo*dot(wo,lb))/r,f));
  float geometry=abs(dot(wi,cross(f.du,f.dv))*determinant(b)/determinant(j))/dot(x-si.position,x-si.position),bsdfPdf;
  vec3 response=openpbr_eval_prepared(prepared,-wi,bsdfPdf);
  float fresnel=sampling_dielectric_fresnel(dot(wi,normal),dielectricEta);
${debug ? '  mneeCounters[10]+=1.0;' : ''}
  solution=si.position;
${debug?'if(mneeTraceEnabled)mneeTrace[7].x=10.0;':''}
  vec3 secondExtinction=dot(x-si.position,si.faceNormal)>0.0?material.mediumExtinction:vec3(0.0);
  vec3 transmittance=exp(-receiver.mediumExtinction*distance(x,si.position)-secondExtinction*(directional?0.0:distance(y,si.position)));
  vec3 interfaceWeight=(1.0-fresnel)*eta*eta*material.transmissionColor,emission=ls.emission;
#ifdef NUM_LIGHTS
  if(point){Light light=fetchLight(ls.sourceIndex);emission=light.emission;if(int(light.type)==SPOT_LIGHT)emission*=evaluateSpotEmissionMultiplier(light,-wo);}
#endif
  if(reflection){
   transmittance=exp(-receiver.mediumExtinction*(distance(x,si.position)+(directional?0.0:distance(y,si.position))));
   interfaceWeight=material.specularWeight*mix(fresnel*material.specularColor,openpbr_metal_fresnel(abs(dot(wi,normal)),material.baseWeight*material.baseColor,material.specularColor),material.baseMetalness);
  }
  return transmittance*response*interfaceWeight*sampling_spectral_rgb_filter(emission,pathWavelength)*geometry/pdfA;
}
vec3 mneeContribution(SurfaceInteraction receiver,OpenPbrPreparedBsdf prepared){
 LightSampleRec ls;sampleMneeLight(receiver.position,vec3(sample2D(causticDim(60u)),sample1D(causticDim(61u))),ls);
${sms ? /* glsl */ `
 if(mneeSeedCount<=0)return vec3(0.0);
 vec3 root;vec3 value=mneeSolve(receiver,prepared,ls,1,root);if(all(equal(root,vec3(INF))))return vec3(0.0);
 float reciprocal=1.0;
${roulette?` float survivalInverse=1.0;
 for(int trial=1;;trial++){`:` for(int trial=1;trial<64;trial++){`}
  vec3 candidate;vec3 ignored=mneeSolve(receiver,prepared,ls,trial+1,candidate);
  if(distance(candidate,root)<1e-3)break;
  reciprocal+=${roulette?'survivalInverse':'1.0'};
${roulette?`  if(trial>=64){
   float t=float(trial),continuation=(t/(t+1.0))*(t/(t+1.0));
   if((sample1D(causticDim(0x40000000u+uint(trial)))-EPS)/(1.0-2.0*EPS)>=continuation)break;
   survivalInverse=((t+1.0)/64.0)*((t+1.0)/64.0);
  }`:''}
 }
 return value*reciprocal;
` : /* glsl */ ` vec3 roots[${seeds}];int count=0;vec3 sum=vec3(0.0);
 for(int seed=0;seed<${seeds};seed++){
  vec3 root;vec3 value=mneeSolve(receiver,prepared,ls,seed,root);if(all(equal(root,vec3(INF))))continue;
  bool duplicate=false;for(int i=0;i<count;i++){if(distance(roots[i],root)<1e-3)duplicate=true;}
  if(!duplicate){roots[count]=root;count++;sum+=value;}
 }
 return sum;`}

}
`});
}
export default createMneeGlsl();
