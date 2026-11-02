// Smooth classification is independent of the sampled lobe. The single-vertex
// marker records either an eligible delta transmission or a smooth reflection.
export function causticPartitionWGSL(mnee: boolean, lightTracing: boolean,photonMapping=false,mneeMaxDepth=20,hot=false,photonMaxDepth=20) {
  return /* wgsl */ `
fn causticDim(slot:u32)->u32{return 1048576u+samplingBounce*4096u+slot;}
fn isCausticSpecular(m: OpenPbrResolvedMaterial) -> bool {
  return m.baseWeight * (1.0 - m.baseMetalness) * (1.0 - m.transmissionWeight) <= 1e-6 &&
    m.subsurfaceWeight <= 0.0 && m.fuzzWeight <= 0.0 && m.coatWeight <= 0.0 && m.causticRoughness <= 0.1;
}
fn isCausticT(m: OpenPbrResolvedMaterial) -> bool {
  return isCausticSpecular(m) && m.transmissionWeight == 1.0 && m.causticRoughness == 0.0 && !m.thinWalled && !m.causticNormalMapped && m.alpha>=1.0;
}
fn isCausticR(m:OpenPbrResolvedMaterial)->bool{
 return isCausticSpecular(m)&&m.causticRoughness==0.0&&!m.causticNormalMapped&&m.alpha>=1.0;
}
fn causticHitOwned(path: Path, mneeLight: bool, tracingLight: bool) -> bool {
  let r1 = ${mnee} && mneeLight && path.causticMneeReceiver && path.causticK == 1u && path.causticSingleT;
  let r2 = ${lightTracing} && tracingLight && path.causticK > 0u && path.causticReceiverPrimary;
  let r3=${photonMapping}&&path.causticPhotonReceiver&&path.causticK>0u;
  return path.causticHasReceiver && (r1 || r2 || r3);
}
// Private evidence images count only unsuppressed PT contributions above 100 after MIS.
var<private> causticHot:array<vec3f,15>;
fn causticHotRecord(path:Path,emission:vec3f,kind:u32){
 if(!${hot}){return;}
 let value=max(max(path.beta.x*emission.x,path.beta.y*emission.y),path.beta.z*emission.z);
 if(value<=100.0){return;}
 causticHot[9][kind]+=1.0;
 causticHot[0]+=vec3f(1.0,f32(samplingBounce),f32(path.causticK));
 causticHot[1]+=vec3f(select(0.0,1.0,path.causticHasReceiver),select(0.0,1.0,path.causticSingleT),select(0.0,1.0,path.causticReceiverPrimary));
 causticHot[2]+=vec3f(select(0.0,1.0,path.causticMneeReceiver),select(0.0,1.0,path.causticPhotonReceiver),value);
 if(samplingBounce>=3u&&samplingBounce<=8u){causticHot[samplingBounce]+=vec3f(1.0,f32(path.causticK),value);}
}
fn causticEstimateRecord(value:vec3f,kind:u32){
 if(!${hot}){return;}
 let peak=max(max(value.x,value.y),value.z);if(peak>100.0){causticHot[10u+kind]+=vec3f(1.0,f32(samplingBounce),peak);}
}
fn causticEmitterRecord(si:SurfaceInteraction,path:Path,weight:f32,emission:vec3f){
 if(!${hot}){return;}
 let value=path.beta*weight*emission;if(max(max(value.x,value.y),value.z)<=100.0){return;}
 let material=materialsBuffer[si.materialIndex];
 causticHot[12]+=vec3f(1.0+dot(si.faceNormal,-path.ray.d),select(0.0,1.0,path.fromEye),material.doubleSided);
 causticHot[13]+=vec3f(weight,material.matType,rtUniform.lightWeightTotal);
 causticHot[14]+=vec3f(path.scatteringPdf,dot(material.emission,luminance),max(max(path.beta.x,path.beta.y),path.beta.z));
}
fn causticAdvance(path: ptr<function, Path>, m: OpenPbrResolvedMaterial, transmission: bool, surface: bool) {
  if (surface && isCausticSpecular(m)) {
    (*path).causticK++;
    (*path).causticSingleT = (*path).causticK == 1u && ((isCausticT(m) && transmission)||(isCausticR(m)&&!transmission));
  } else {
    (*path).causticK = 0u;
    (*path).causticSingleT = false;
    (*path).causticPhotonReceiver=surface&&samplingBounce<=${photonMaxDepth}u&&m.materialType!=SHADOW_CATCHER;
    (*path).causticHasReceiver = m.materialType != SHADOW_CATCHER;
    (*path).causticMneeReceiver = surface && samplingBounce<=${mneeMaxDepth}u &&
      m.baseWeight*(1.0-m.baseMetalness)*(1.0-m.transmissionWeight)>0.0 && m.subsurfaceWeight==0.0;
    (*path).causticReceiverPrimary = (*path).fromEye && surface;
  }
}
`;
}
