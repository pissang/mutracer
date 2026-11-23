import type {DenoisingGuideCapture} from '../denoisingGuideCapture.js';
import guides, {glslDenoisingPathSupports} from './aovDenoisingGuide.glsl.js';
import reflectance from './aovReflectance.glsl.js';

export function denoisingGuideCaptureGlsl(mode: DenoisingGuideCapture) {
  const albedo = mode === 'surface' ? 'guideFirst.diffuse'
    : mode === 'path' ? 'guidePath.diffuse' : 'vec3(dot(guideFirst.specular, vec3(1.0 / 3.0)), guidePath.depth, float(guideHits))';
  const normal = mode === 'surface' ? 'guideFirst.normalRoughness.xyz' : 'guidePath.normal';
  return {
    declarations: reflectance + guides + glslDenoisingPathSupports + /* glsl */ `
AovDenoisingPathGuide guidePath;
AovDenoisingGuide guideFirst;
int guideHits;
`,
    begin: /* glsl */ `
  guidePath = AovDenoisingPathGuide(vec3(1.0), vec3(0.0), vec3(0.0), 0.0);
  guideFirst = AovDenoisingGuide(vec3(0.0), vec3(0.0), vec4(0.0));
  guideHits = 0;
`,
    surface: /* glsl */ `
    if (pathWavelength > 0.0 || !aovDenoisingPathSupports(mat)) {
      guidePath.throughput = vec3(0.0);
    }
    if (any(greaterThan(guidePath.throughput, vec3(0.0)))) {
      vec3 diffuse, specular, coat;
      aovReflectance(prepared, true, true, diffuse, specular, coat);
      AovDenoisingGuide surfaceGuide = aovDenoisingGuide(prepared, diffuse, specular, coat);
      if (guideHits == 0) { guideFirst = surfaceGuide; }
      aovFollowDenoisingPath(guidePath, surfaceGuide, distance(path.ray.o, si.position));
      guideHits++;
    }
`,
    finish: `  outAux.albedo = ${albedo}; outAux.normal = ${normal};\n`,
  };
}
