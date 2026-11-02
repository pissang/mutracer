// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

export default /*wgsl*/ `

// A one-sample binary shadow test leaves scattered fully dark pixels far
// from the occluder at low sample counts. Averaging a few light samples per
// primary hit costs only shadow rays and lets the mask settle much sooner.
const SHADOW_CATCHER_LIGHT_SAMPLES = 4u;

// Returns the occluded and the total count of light samples that reach the
// visible side of this hit. The shadow opacity is the ratio of their sums over
// all samples; samples that carry no light, such as those from below the
// receiver, do not dilute it. Weighting by Le * cos / pdf instead is unbiased
// but noisier, because the environment CDF dilates bright texels.
fn sampleShadowCatcher(si: SurfaceInteraction, bounce: i32, path: ptr<function, Path>) -> vec2f {
  let viewDir = -(*path).ray.d;
  var counts = vec2f(0.0);

  // The catcher table holds only the environment and analytic lights, as in
  // WebGL 2: emissive meshes are scene objects, not light in the plate.
  if (rtUniform.shadowCatcherChoiceCount > 0) {
    for (var candidate = 0u; candidate < SHADOW_CATCHER_LIGHT_SAMPLES; candidate++) {
      var lightSample: LightSampleRec;
      let lightRnd = vec3f(sample2D(lightDim(candidate, 1u)), sample1D(lightDim(candidate, 0u)));
      sampleLightChoiceTable(
        si.position,
        lightRnd,
        rtUniform.shadowCatcherChoiceOffset,
        rtUniform.shadowCatcherChoiceCount,
        1.0,
        &lightSample
      );
      let lightDir = lightSample.direction;
      let cosThetaL = dot(si.normal, lightDir);
      let orientation = dot(si.normal, viewDir) * cosThetaL;
      if (lightSample.pdf > 0.0 && orientation >= 0.0) {
        if (dot(lightSample.emission, luminance) * abs(cosThetaL) > 0.0) {
          var ray: Ray;
          initRay(&ray, si.position + EPS * lightDir, lightDir);
          let occluded = intersectSceneShadow(ray, lightSample.dist - EPS, si.triangleIndex,si.instanceIndex);
          counts += vec2f(select(0.0, 1.0, occluded), 1.0);
        }
      }
    }
  }
  (*path).fromEye = false;
  return counts;
}
`;
