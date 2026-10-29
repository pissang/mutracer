import {INSTANCE_VEC4_STRIDE} from '../../bvhAccel.js';
// Single-interface manifold connection. Constraint differentiation follows
// Hanika et al., Manifold Next Event Estimation (2015), https://jo.dreggn.org/home/2015_mnee.pdf.
// This implementation uses the implicit 2x2 map directly; no reference code is copied.
export function createMneeWgsl(debug = false,sms=false,hardwareIndices=false,seeds=4,damping=false,maxDepth=20,roulette=false) { return /* wgsl */ `
${debug ? /* wgsl */ `var<private> mneeCounters: array<u32,21>; var<private> mneeTrace:array<vec3f,10>; var<private> mneeTraceEnabled:bool;` : ''}
fn mneeFail(reason: u32) -> vec3f { ${debug ? 'mneeCounters[reason]++; if(mneeTraceEnabled){mneeTrace[7].x=f32(reason);}' : ''} return vec3f(0.0); }
struct MneeFrame {
  origin:vec3f, du: vec3f, dv: vec3f, nu: vec3f, nv: vec3f,
  t: vec3f, b: vec3f,
}
fn mneeFrame(si: SurfaceInteraction) -> MneeFrame {
  let off = si.instanceIndex * ${INSTANCE_VEC4_STRIDE};
  let index = ${hardwareIndices?'mtIndices(si.instanceIndex,si.triangleIndex)':'bitcast<vec3i>(bvhBuffer[si.triangleIndex].xyz) + vec3i(bitcast<i32>(instancesBuffer[off].y))'};
  let l2w = mat4x4f(instancesBuffer[off+5], instancesBuffer[off+6], instancesBuffer[off+7], instancesBuffer[off+8]);
  let w2l = mat4x4f(instancesBuffer[off+1], instancesBuffer[off+2], instancesBuffer[off+3], instancesBuffer[off+4]);
  let nm = transpose(mat3x3f(w2l[0].xyz, w2l[1].xyz, w2l[2].xyz));
  let p0 = attrBuffers[index.x * ATTR_STRIDE + POSITION_OFF].xyz;
  let p1 = attrBuffers[index.y * ATTR_STRIDE + POSITION_OFF].xyz;
  let p2 = attrBuffers[index.z * ATTR_STRIDE + POSITION_OFF].xyz;
  let n0 = nm * attrBuffers[index.x * ATTR_STRIDE + NORMAL_OFF].xyz;
  let n1 = nm * attrBuffers[index.y * ATTR_STRIDE + NORMAL_OFF].xyz;
  let n2 = nm * attrBuffers[index.z * ATTR_STRIDE + NORMAL_OFF].xyz;
  let bary = vec3f(si.barycentrics, 1.0-si.barycentrics.x-si.barycentrics.y);
  let rawN = n0*bary.x+n1*bary.y+n2*bary.z;
  let n = normalize(rawN);
  var f: MneeFrame;
  f.du = (l2w * vec4f(p1-p0, 0.0)).xyz;
  f.dv = (l2w * vec4f(p2-p0, 0.0)).xyz;
  f.origin=(l2w*vec4f(p0,1.0)).xyz;
  f.nu = (n1-n0-n*dot(n,n1-n0)) / max(length(rawN), 1e-8);
  f.nv = (n2-n0-n*dot(n,n2-n0)) / max(length(rawN), 1e-8);
  var tangent: vec3f; var bitangent: vec3f;
  sampling_orthonormal_basis(si.normal, &tangent, &bitangent);
  f.t = tangent; f.b = bitangent;
  return f;
}
fn mneeProject(v: vec3f, f: MneeFrame) -> vec2f { return vec2f(dot(v,f.t),dot(v,f.b)); }
fn mneeColumn(dp: vec3f, dn: vec3f, wi: vec3f, wo: vec3f, ri: f32, ro: f32, eta: f32, n: vec3f, f: MneeFrame) -> vec2f {
  let dq = -(dp-wo*dot(wo,dp))/ro-eta*(dp-wi*dot(wi,dp))/ri;
  return mneeProject(dq - dot(wo+eta*wi,n)*dn, f);
}
fn mneeMatrix(si: SurfaceInteraction, x: vec3f, y: vec3f, eta: f32, f: MneeFrame, directional:bool) -> mat2x2f {
  let wi = normalize(x-si.position); let wo = normalize(y-si.position);
  return mat2x2f(
    mneeColumn(f.du,f.nu,wi,wo,distance(x,si.position),select(distance(y,si.position),INF,directional),eta,si.normal,f),
    mneeColumn(f.dv,f.nv,wi,wo,distance(x,si.position),select(distance(y,si.position),INF,directional),eta,si.normal,f));
}
fn mneeSolve2(j: mat2x2f, v: vec2f) -> vec2f {
  return vec2f(j[1].y*v.x-j[1].x*v.y, j[0].x*v.y-j[0].y*v.x)/determinant(j);
}
fn mneeDiffuse(m: OpenPbrResolvedMaterial) -> bool {
  return m.baseWeight*(1.0-m.baseMetalness)*(1.0-m.transmissionWeight) > 0.0 && m.subsurfaceWeight == 0.0;
}
fn mneeSolve(receiver: SurfaceInteraction, prepared: OpenPbrPreparedBsdf, ls:LightSampleRec, seed:u32, solution:ptr<function,vec3f>) -> vec3f {
  if (samplingBounce>${maxDepth}u || !mneeDiffuse(prepared.material)) { return vec3f(0.0); }
${debug ? '  mneeCounters[0]++; mneeTraceEnabled=seed==0u;if(mneeTraceEnabled){mneeTrace[0]=receiver.position;mneeTrace[5]=receiver.position+ls.direction*ls.dist;mneeTrace[9]=vec3f(f32(ls.sourceType),ls.pdf,ls.normal.y);}' : ''}
  if(ls.sourceType==0u||ls.pdf<=0.0){return mneeFail(1u);}
  var directional=false;var point=false;
  if(ls.sourceType==2u){
    let kind=i32(analyticLights[ls.sourceIndex].litType);directional=kind==DIRECTIONAL_LIGHT;
    point=ls.isDelta&&!directional;
  }
  let x=receiver.position;let y=x+ls.direction*select(ls.dist,1e8,directional);
  var pdfA=ls.pdf;
  if(ls.sourceType!=1u&&!directional&&!point){pdfA*=abs(dot(ls.normal,-ls.direction))/(ls.dist*ls.dist);}
  if(pdfA<=0.0){return mneeFail(1u);}
  var direction=ls.direction;
  if(seed>0u&&CAUSTIC_SEED_COUNT>0){direction=normalize(mneeSeed(x,seed)-x);}
  var ray:Ray;initRay(&ray,x+EPS*direction,direction);var si:SurfaceInteraction;
${debug ? '  mneeCounters[12]++;' : ''}
  intersectScene(ray,&si,0,true,true);
  if(!si.hit||(seed==0u&&!directional&&distance(x,si.position)>=ls.dist-EPS)){return mneeFail(2u);}
  var material: OpenPbrResolvedMaterial;
  var eta = 1.0;var reflection=false;var dielectricEta=1.0;
  for (var iteration=0; iteration<${damping?20:10}; iteration++) {
    getMaterial(&material,si.materialIndex,si.uv,si.uv1,si.instanceIndex,si.vertexColor);
    reflection=dot(x-si.position,si.faceNormal)*dot(y-si.position,si.faceNormal)>0.0;
    ${debug ? 'if(iteration==0){mneeCounters[15]++;if(reflection){mneeCounters[16]++;}if(!isCausticSpecular(material)){mneeCounters[17]++;}if(mneeTraceEnabled){mneeTrace[0]=x;mneeTrace[1]=si.position;mneeTrace[2]=si.normal;mneeTrace[3]=si.faceNormal;mneeTrace[4]=vec3f(material.specularIor,select(0.0,1.0,reflection),f32(si.instanceIndex));mneeTrace[5]=y;}}' : ''}
    if((reflection&&!isCausticR(material))||(!reflection&&!isCausticT(material))){${debug?'if(iteration==0){mneeCounters[18]++;}else{mneeCounters[19]++;}':''}return mneeFail(3u);}
    var ior = material.specularIor;
    if (SPECTRAL && receiver.wavelength > 0.0) {
      ior = sampling_cauchy_ior(receiver.wavelength,ior,material.transmissionDispersionScale,material.dispersionAbbeNumber);
    }
    dielectricEta=select(ior,1.0/ior,dot(x-si.position,si.faceNormal)>0.0);
    eta=select(dielectricEta,1.0,reflection);
    let f = mneeFrame(si);
    let q = normalize(y-si.position)+eta*normalize(x-si.position);
    let c = mneeProject(q,f);
${debug?'if(mneeTraceEnabled){mneeTrace[6]=vec3f(eta,length(c),f32(iteration));mneeTrace[8]=si.position;}':''}
    // Use bounded damped Newton iterations; converged points need no further traversal.
    if (length(c) < 1e-5) { break; }
${debug ? '    mneeCounters[11]++;' : ''}
    let j = mneeMatrix(si,x,y,eta,f,directional);
    if (!(abs(determinant(j)) >= 1e-12)) { return mneeFail(4u); }
    let step = mneeSolve2(j,c);
    if(!all(abs(step)<vec2f(INF))){return mneeFail(4u);}
${damping?/* wgsl */ `    let position=si.position;let interfaceInstance=si.instanceIndex;let interfaceMaterial=si.materialIndex;
    var scale=1.0;var improved=false;
    for(var backtrack=0;backtrack<i32(min(8u,rtUniform.loopUnrollGuard*2u));backtrack++){
      let proposal=position-scale*(f.du*step.x+f.dv*step.y);
      if(!all(abs(proposal)<vec3f(INF))||dot(proposal-x,proposal-x)<1e-16){scale*=0.5;continue;}
      let direction=normalize(proposal-x);initRay(&ray,x+EPS*direction,direction);
${debug ? '      mneeCounters[12]++;' : ''}
      intersectScene(ray,&si,0,true,true);
      if(si.hit&&si.instanceIndex==interfaceInstance&&si.materialIndex==interfaceMaterial){
        let nextReflection=dot(x-si.position,si.faceNormal)*dot(y-si.position,si.faceNormal)>0.0;
        let nextEta=select(ior,1.0/ior,dot(x-si.position,si.faceNormal)>0.0);
        let nextQ=normalize(y-si.position)+select(nextEta,1.0,reflection)*normalize(x-si.position);
        var tangent:vec3f;var bitangent:vec3f;sampling_orthonormal_basis(si.normal,&tangent,&bitangent);
        let nextC=vec2f(dot(nextQ,tangent),dot(nextQ,bitangent));
        if(nextReflection==reflection&&length(nextC)<length(c)){
          improved=true;break;
        }
      }
      scale*=0.5;
    }
    if(!improved){return mneeFail(5u);}`:/* wgsl */ `
    let proposal=si.position-f.du*step.x-f.dv*step.y;
    if(!all(abs(proposal)<vec3f(INF))||dot(proposal-x,proposal-x)<1e-16){return mneeFail(5u);}
    let direction=normalize(proposal-x);initRay(&ray,x+EPS*direction,direction);
${debug?'    mneeCounters[12]++;':''}intersectScene(ray,&si,0,true,true);if(!si.hit){return mneeFail(5u);}
`}
  }
  let f = mneeFrame(si);
  let wi = normalize(x-si.position); let wo = normalize(y-si.position);
  if (length(mneeProject(wo+eta*wi,f)) > 1e-4 || (dot(wi,si.faceNormal)*dot(wo,si.faceNormal)>0.0)!=reflection) { return mneeFail(6u); }
  let normal = select(-si.normal,si.normal,dot(wi,si.normal)>=0.0);
  let refracted = select(refract(-wi,normal,eta),reflect(-wi,normal),reflection);
  if (dot(refracted,refracted)<0.5 || dot(refracted,wo)<0.9999) { return mneeFail(7u); }
  // Every projection came from x: the first segment already has nearest-hit visibility.
  initRay(&ray,si.position+EPS*wo,wo);
  let end = y+EPS*ls.normal;
${debug ? '  mneeCounters[13]++;' : ''}
  if (intersectSceneShadow(ray,max(distance(ray.o,end)-EPS,0.0),si.triangleIndex,si.instanceIndex)) { return mneeFail(8u); }
  if (!directional&&!point&&dot(ls.normal,-wo)<=0.0) { return mneeFail(9u); }
  if (ls.sourceType == 2u && i32(analyticLights[ls.sourceIndex].litType)==RECT_LIGHT) {
    let light = analyticLights[ls.sourceIndex];
    if (dot(ls.normal,-wo)<cos(0.5*PI*light.radiusOrSpread)) { return mneeFail(9u); }
  }
  let j = mneeMatrix(si,x,y,eta,f,directional);
  if (!(abs(determinant(j))>=1e-12)) { return mneeFail(4u); }
  var lt: vec3f; var lb: vec3f;
  sampling_orthonormal_basis(select(ls.normal,-wo,point),&lt,&lb);
  let r = select(distance(y,si.position),1.0,directional);
  let b = mat2x2f(mneeProject((lt-wo*dot(wo,lt))/r,f),mneeProject((lb-wo*dot(wo,lb))/r,f));
  // dOmega_x / dA_y from the single-vertex implicit manifold map.
  let geometry = abs(dot(wi,cross(f.du,f.dv))*determinant(b)/determinant(j)) / dot(x-si.position,x-si.position);
  var bsdfPdf: f32;
  let response = openpbr_eval_prepared(prepared,-wi,&bsdfPdf);
  let fresnel = sampling_dielectric_fresnel(dot(wi,normal),dielectricEta);
  var emission=ls.emission;
  if(point){
    let light=analyticLights[ls.sourceIndex];emission=light.emission;
    if(i32(light.litType)==SPOT_LIGHT){emission*=evaluateSpotEmissionMultiplier(light,-wo);}
  }
  if (SPECTRAL) { emission = sampling_spectral_rgb_filter(emission,receiver.wavelength); }
${debug ? '  mneeCounters[10]++;' : ''}
  *solution=si.position;
${debug?'if(mneeTraceEnabled){mneeTrace[7].x=10.0;}':''}
  let secondExtinction=select(vec3f(0.0),material.mediumExtinction,dot(x-si.position,si.faceNormal)>0.0);
  var transmittance=exp(-receiver.mediumExtinction*distance(x,si.position)-secondExtinction*select(distance(y,si.position),0.0,directional));
  var interfaceWeight=(1.0-fresnel)*eta*eta*material.transmissionColor;
  if(reflection){
    transmittance=exp(-receiver.mediumExtinction*(distance(x,si.position)+select(distance(y,si.position),0.0,directional)));
    interfaceWeight=material.specularWeight*mix(fresnel*material.specularColor,openpbr_metal_fresnel(abs(dot(wi,normal)),material.baseWeight*material.baseColor,material.specularColor),material.baseMetalness);
  }
  return transmittance*response*interfaceWeight*emission*geometry/pdfA;
}
fn mneeSeed(receiver:vec3f,seed:u32)->vec3f {
 let rnd=vec3f(sample2D(causticDim(100u+seed*2u)),sample1D(causticDim(101u+seed*2u)));
 var low=0;var high=i32(CAUSTIC_SEED_COUNT)-1;
 for(var step=0;step<32;step++){
  if(low>=high){break;}let middle=(low+high)/2;
  if(loadLightSamplingTexel(i32(CAUSTIC_SEED_OFFSET)+middle*3).w<rnd.z){low=middle+1;}else{high=middle;}
 }
 let offset=i32(CAUSTIC_SEED_OFFSET)+low*3;
 let a=loadLightSamplingTexel(offset).xyz;let b=loadLightSamplingTexel(offset+1).xyz;let c=loadLightSamplingTexel(offset+2).xyz;
 let u=sqrt(rnd.x);return a*(1.0-u)+b*u*(1.0-rnd.y)+c*u*rnd.y;
}
fn mneeContribution(receiver:SurfaceInteraction,prepared:OpenPbrPreparedBsdf)->vec3f {
  var ls:LightSampleRec;
  let rnd=vec3f(sample2D(causticDim(60u)),sample1D(causticDim(61u)));
  sampleLight(receiver.position,rnd,&ls,false);
  // Manifold connections sample emitter area, not the unbent receiver direction.
  // A receiver behind a one-sided emitter can still see its front via reflection.
  if(ls.sourceType==1u){
    let triangle=getEmissiveTriangle(i32(ls.sourceIndex));let u=sqrt(rnd.x);
    let bary=vec3f(1.0-u,u*(1.0-rnd.y),u*rnd.y);
    ls.emission=getMaterialEmission(i32(triangle.materialIndex),bary.x*triangle.uv0+bary.y*triangle.uv1+bary.z*triangle.uv2,
      bary.x*triangle.secondaryUv0+bary.y*triangle.secondaryUv1+bary.z*triangle.secondaryUv2);
    ls.pdf=triangle.selectionPmf/triangle.area;
  }
${sms ? /* wgsl */ `
  if(CAUSTIC_SEED_COUNT<=0){return vec3f(0.0);}
  var root=vec3f(INF);let value=mneeSolve(receiver,prepared,ls,1u,&root);
  if(all(root==vec3f(INF))){return vec3f(0.0);}
  // Geometric waiting time estimates the reciprocal probability of this root.
  // A finite cap truncates the tail and is deliberately reported as biased.
  var reciprocal=1.0;
${roulette?`  var survivalInverse=1.0;
  for(var trial=1u;;trial++){`:`  for(var trial=1u;trial<64u;trial++){`}
    var candidate=vec3f(INF);let ignored=mneeSolve(receiver,prepared,ls,trial+1u,&candidate);
    if(distance(candidate,root)<1e-3){break;}
    reciprocal+=${roulette?'survivalInverse':'1.0'};
${roulette?`    if(trial>=64u){
      let t=f32(trial);let continuation=(t/(t+1.0))*(t/(t+1.0));
      if((sample1D(causticDim(0x40000000u+trial))-EPS)/(1.0-2.0*EPS)>=continuation){break;}
      survivalInverse=((t+1.0)/64.0)*((t+1.0)/64.0);
    }`:''}
  }
  return value*reciprocal;
` : /* wgsl */ `  var roots:array<vec3f,${seeds}>;var count=0u;var sum=vec3f(0.0);
  for(var seed=0u;seed<${seeds}u;seed++){
    var root=vec3f(INF);let value=mneeSolve(receiver,prepared,ls,seed,&root);
    if(all(root==vec3f(INF))){continue;}
    var duplicate=false;
    for(var i=0u;i<count;i++){if(distance(roots[i],root)<1e-3){duplicate=true;}}
    if(!duplicate){roots[count]=root;count++;sum+=value;}
  }
  return sum;`}

}
`;
}
export default createMneeWgsl();
