export const glslFragments = {
  core0: /* glsl */ `
  float causticRoughness;
  bool causticNormalMapped;`,
  core1: /* glsl */ `
  int causticK;
  bool causticSingleT;
  bool causticReceiverPrimary;
  bool causticHasReceiver;
  bool causticMneeReceiver;`,
  material0: /* glsl */ `  mat.causticRoughness = mat.specularRoughness;
  mat.causticNormalMapped = roughnessAndNormal.y >= 0.0;
`,
  sample0: /* glsl */ `
  if(isSurface&&isCausticSpecular(mat)){
    Path connection=path;causticAdvance(connection,mat,dot(ffnormal,lightSample.direction)<0.0,true);
    if(lightSample.sourceType!=0&&causticHitOwned(connection))return vec3(0.0);
  }`,
  sample1: /* glsl */ `  Path connection=path;
  if(isSurface&&isCausticSpecular(mat))causticAdvance(connection,mat,dot(ffnormal,lightDir)<0.0,true);
  causticHotRecord(connection,misWeight*lightSample.emission*f/lightPdf,0);
`,
  sample2: /* glsl */ 'if (!causticHitOwned(path)) { causticHotRecord(path,emissiveHitMisWeight(si,path)*mat.emission,1);causticEmitterRecord(si,path,emissiveHitMisWeight(si,path),mat.emission); ',
  sample3: /* glsl */ ' }',
  sample4: /* glsl */ `    vec3 manifoldValue=path.beta*mneeContribution(si,prepared);causticEstimateRecord(manifoldValue,0);path.li+=manifoldValue;
`,
  sample5: /* glsl */ `    causticAdvance(path, mat, isNextRefraction, true);
`,
  sample6: /* glsl */ `
    causticAdvance(path, mat, false, false);`,
};
