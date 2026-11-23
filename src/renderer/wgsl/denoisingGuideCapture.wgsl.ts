import type {DenoisingGuideCapture} from '../denoisingGuideCapture.js';
import type {RayTraceInputHooks} from './rayTrace.compute.js';
import {createAovDenoisingGuideWgsl, wgslDenoisingPathSupports} from './aovDenoisingGuide.wgsl.js';

export function denoisingGuideCaptureWgsl(mode: DenoisingGuideCapture, hasCoatNormals: boolean): RayTraceInputHooks {
  const albedo = mode === 'surface' ? 'guideFirst.diffuse'
    : mode === 'path' ? 'guidePath.diffuse' : 'vec3f(dot(guideFirst.specular, vec3f(1.0 / 3.0)), guidePath.depth, f32(guideHits))';
  const normal = mode === 'surface' ? 'guideFirst.normalRoughness.xyz' : 'guidePath.normal';
  return {
    declarations: createAovDenoisingGuideWgsl(hasCoatNormals) + wgslDenoisingPathSupports + /* wgsl */ `
var<private> guidePath: AovDenoisingPathGuide;
var<private> guideFirst: AovDenoisingGuide;
var<private> guideHits: u32;
`,
    begin: /* wgsl */ `
  guidePath = AovDenoisingPathGuide(vec3f(1.0), vec3f(0.0), vec3f(0.0), 0.0);
  guideFirst = AovDenoisingGuide();
  guideHits = 0u;
`,
    primarySurface: '',
    preparedSurface: (prepared) => /* wgsl */ `
    if (SPECTRAL || !aovDenoisingPathSupports(${prepared}.material)) {
      guidePath.throughput = vec3f(0.0);
    }
    if (any(guidePath.throughput > vec3f(0.0))) {
      let surfaceGuide = aovDenoisingGuide(${prepared}, mtFrameReflectance(${prepared}));
      if (guideHits == 0u) { guideFirst = surfaceGuide; }
      var updated = guidePath;
      aovFollowDenoisingPath(&updated, surfaceGuide, distance((*path).ray.o, (*si).position));
      guidePath = updated;
      guideHits++;
    }
`,
    unclampedColor: `  outAux.albedo = ${albedo}; outAux.normal = ${normal};\n`,
    end: '',
    uniformJitter: false,
    layeredReflectance: true,
  };
}
