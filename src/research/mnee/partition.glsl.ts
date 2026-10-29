export function createCausticPartitionGlsl(maxDepth=20,hot=false){return /* glsl */ `
uint causticDim(uint slot){return 1048576u+samplingBounce*4096u+slot;}
bool isCausticSpecular(OpenPbrResolvedMaterial m) {
  return m.baseWeight * (1.0 - m.baseMetalness) * (1.0 - m.transmissionWeight) <= 1e-6 &&
    m.subsurfaceWeight <= 0.0 && m.fuzzWeight <= 0.0 && m.coatWeight <= 0.0 && m.causticRoughness <= 0.1;
}
bool isCausticT(OpenPbrResolvedMaterial m) {
  return isCausticSpecular(m) && m.transmissionWeight == 1.0 && m.causticRoughness == 0.0 && !m.thinWalled && !m.causticNormalMapped && m.alpha>=1.0;
}
bool isCausticR(OpenPbrResolvedMaterial m){
 return isCausticSpecular(m)&&m.causticRoughness==0.0&&!m.causticNormalMapped&&m.alpha>=1.0;
}
bool causticHitOwned(Path path) {
  return path.causticHasReceiver && path.causticMneeReceiver && path.causticK == 1 && path.causticSingleT;
}
vec3 causticHot[15];
void causticHotRecord(Path path,vec3 emission,int kind){
 if(!${hot})return;
 float value=max(max(path.beta.x*emission.x,path.beta.y*emission.y),path.beta.z*emission.z);
 if(value<=100.0)return;
 causticHot[9][kind]+=1.0;
 causticHot[0]+=vec3(1.0,float(samplingBounce),float(path.causticK));
 causticHot[1]+=vec3(path.causticHasReceiver?1.0:0.0,path.causticSingleT?1.0:0.0,path.causticReceiverPrimary?1.0:0.0);
 causticHot[2]+=vec3(path.causticMneeReceiver?1.0:0.0,0.0,value);
 if(samplingBounce>=3u&&samplingBounce<=8u)causticHot[samplingBounce]+=vec3(1.0,float(path.causticK),value);
}
void causticEstimateRecord(vec3 value,int kind){
 if(!${hot})return;
 float peak=max(max(value.x,value.y),value.z);if(peak>100.0)causticHot[10+kind]+=vec3(1.0,float(samplingBounce),peak);
}
void causticEmitterRecord(SurfaceInteraction si,Path path,float weight,vec3 emission){
 if(!${hot})return;
 vec3 value=path.beta*weight*emission;if(max(max(value.x,value.y),value.z)<=100.0)return;
 int i=si.materialIndex*MAT_DATA_SIZE;
 causticHot[12]+=vec3(1.0+dot(si.faceNormal,-path.ray.d),path.fromEye?1.0:0.0,fetchMatData(i+MAT_ROW_ALPHA).z);
 causticHot[13]+=vec3(weight,fetchMatData(i+MAT_ROW_COLOR).w,emissiveWeightTotal);
 causticHot[14]+=vec3(path.scatteringPdf,dot(fetchMatData(i+MAT_ROW_EMISSION).rgb,vec3(.2126,.7152,.0722)),max(max(path.beta.x,path.beta.y),path.beta.z));
}
void causticAdvance(inout Path path, OpenPbrResolvedMaterial m, bool transmission, bool surface) {
  if (surface && isCausticSpecular(m)) {
    path.causticK++;
    path.causticSingleT = path.causticK == 1 && ((isCausticT(m) && transmission)||(isCausticR(m)&&!transmission));
  } else {
    path.causticK = 0;
    path.causticSingleT = false;
    path.causticHasReceiver = m.materialType != SHADOW_CATCHER;
    path.causticMneeReceiver = surface && samplingBounce<=${maxDepth}u && m.baseWeight*(1.0-m.baseMetalness)*(1.0-m.transmissionWeight)>0.0 && m.subsurfaceWeight==0.0;
    path.causticReceiverPrimary = path.fromEye && surface;
  }
}
`;}
export default createCausticPartitionGlsl();
