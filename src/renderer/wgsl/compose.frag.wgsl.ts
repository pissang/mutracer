/** Mode indices understood by applyToneMapping. */
export const TONE_MAPPING_MODES: Readonly<Record<string, number>> = {agx: 0, aces: 1, cineon: 2, reinhard: 3, linear: 4};

export const linearToSrgbDefine = /* wgsl */ `
fn linearToSrgb(color: vec3f) -> vec3f {
  let linear = max(color, vec3f(0.0));
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}
`;

export const composeDefine = /* wgsl */ `

fn linearToneMapping(color: vec3f) -> vec3f {
  return clamp(color, vec3f(0.0), vec3f(1.0));
}
fn reinhardToneMapping(color: vec3f) -> vec3f {
  return clamp(color / (vec3f(1.0) + color), vec3f(0.0), vec3f(1.0));
}
fn cineonToneMapping(inputColor: vec3f) -> vec3f {
  let color = max(vec3f(0.0), inputColor - 0.004);
  return pow((color * (6.2 * color + 0.5)) /
    (color * (6.2 * color + 1.7) + 0.06), vec3f(2.2));
}
fn rrtAndOdtFit(value: vec3f) -> vec3f {
  let numerator = value * (value + 0.0245786) - 0.000090537;
  let denominator = value * (0.983729 * value + 0.4329510) + 0.238081;
  return numerator / denominator;
}
fn acesToneMapping(inputColor: vec3f) -> vec3f {
  let inputMatrix = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777)
  );
  let outputMatrix = mat3x3f(
    vec3f(1.60475, -0.10208, -0.00327),
    vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602)
  );
  let color = inputMatrix * (inputColor / 0.6);
  return clamp(outputMatrix * rrtAndOdtFit(color), vec3f(0.0), vec3f(1.0));
}
fn agxDefaultContrastApprox(value: vec3f) -> vec3f {
  let value2 = value * value;
  let value4 = value2 * value2;
  return 15.5 * value4 * value2 - 40.14 * value4 * value
    + 31.96 * value4 - 6.868 * value2 * value
    + 0.4298 * value2 + 0.1191 * value - 0.00232;
}
fn agxToneMapping(inputColor: vec3f) -> vec3f {
  let linearRec2020ToLinearSrgb = mat3x3f(
    vec3f(1.6605, -0.1246, -0.0182),
    vec3f(-0.5876, 1.1329, -0.1006),
    vec3f(-0.0728, -0.0083, 1.1187)
  );
  let linearSrgbToLinearRec2020 = mat3x3f(
    vec3f(0.6274, 0.0691, 0.0164),
    vec3f(0.3293, 0.9195, 0.0880),
    vec3f(0.0433, 0.0113, 0.8956)
  );
  let insetMatrix = mat3x3f(
    vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859)
  );
  let outsetMatrix = mat3x3f(
    vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  var color = insetMatrix * (linearSrgbToLinearRec2020 * inputColor);
  color = clamp((log2(max(color, vec3f(1e-10))) + 12.47393) / 16.5, vec3f(0.0), vec3f(1.0));
  color = outsetMatrix * agxDefaultContrastApprox(color);
  color = pow(max(color, vec3f(0.0)), vec3f(2.2));
  return clamp(linearRec2020ToLinearSrgb * color, vec3f(0.0), vec3f(1.0));
}
fn applyToneMapping(color: vec3f) -> vec3f {
  let toneMappingMode = i32(toneMappingParams.x);
  if (toneMappingMode == 1) { return acesToneMapping(color); }
  if (toneMappingMode == 2) { return cineonToneMapping(color); }
  if (toneMappingMode == 3) { return reinhardToneMapping(color); }
  if (toneMappingMode == 4) { return linearToneMapping(color); }
  return agxToneMapping(color);
}
${linearToSrgbDefine}
fn gradeColor(inputColor: vec3f) -> vec3f {
  let contrast = colorGradingParams.x;
  let saturation = colorGradingParams.y;
  let temperature = colorGradingParams.z;
  let tint = colorGradingParams.w;
  let balance = vec3f(
    1.0 + temperature * 0.16 + tint * 0.04,
    1.0 - tint * 0.12,
    1.0 - temperature * 0.16 + tint * 0.04
  );
  var color = max(inputColor * balance, vec3f(0.0));
  color = max((color - 0.18) * contrast + 0.18, vec3f(0.0));
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(luminance), color, saturation), vec3f(0.0));
}
`;

export function createComposeMain(sdrEncoding: 'gamma22' | 'srgb' = 'srgb'): string {
  return /* wgsl */ `

var finalColor = load_colorTex(uv, 0);
var bloomTexel = vec4(0.0);
if (bloomIntensity > 0.0) {
  bloomTexel = load_bloomTex(uv, 0) * bloomIntensity;
  finalColor = vec4f(finalColor.rgb + bloomTexel.rgb, finalColor.a);
}

var gradedColor = gradeColor(finalColor.rgb * exposure);
let vignetteEdge = smoothstep(0.2, 0.72, distance(vec2f(uv) / vec2f(colorTexRegion()), vec2f(0.5)));
gradedColor *= 1.0 - toneMappingParams.y * vignetteEdge;
let hdrOutput = hdrOutputEnabled > 0.5;
if (!hdrOutput) {
  gradedColor = applyToneMapping(gradedColor);
}
let encodedDisplay = select(
  ${sdrEncoding === 'srgb' ? 'linearToSrgb(gradedColor)' : 'pow(max(gradedColor, vec3f(0.0)), vec3f(1.0 / 2.2))'},
  linearToSrgb(gradedColor),
  hdrOutput
);
var displayColor = encodedDisplay;
if (flatBackgroundColor.a > 0.5) {
  let surfaceCoverage = clamp(
    load_flatBackgroundMaskTex(uv, 0).a,
    0.0,
    1.0
  );
  let flatBackgroundDisplay = linearToSrgb(max(flatBackgroundColor.rgb, vec3f(0.0)));
  displayColor = mix(flatBackgroundDisplay, encodedDisplay, surfaceCoverage);
  if (bloomIntensity > 0.0) {
    var unbloomedColor = gradeColor(
      max(finalColor.rgb - bloomTexel.rgb, vec3f(0.0))
        * exposure
    );
    unbloomedColor *= 1.0 - toneMappingParams.y * vignetteEdge;
    if (!hdrOutput) {
      unbloomedColor = applyToneMapping(unbloomedColor);
    }
    let encodedUnbloomed = select(
      ${sdrEncoding === 'srgb' ? 'linearToSrgb(unbloomedColor)' : 'pow(max(unbloomedColor, vec3f(0.0)), vec3f(1.0 / 2.2))'},
      linearToSrgb(unbloomedColor),
      hdrOutput
    );
    displayColor += max(encodedDisplay - encodedUnbloomed, vec3f(0.0))
      * (1.0 - surfaceCoverage);
  }
}
finalColor = vec4f(displayColor, finalColor.a);
if (bloomIntensity > 0.0) {
  finalColor.a = max(finalColor.a, min(dot(bloomTexel.rgb, vec3f(0.2125, 0.7154, 0.0721)), 1.0));
}

if (shadowCatcherEnabled > 0.5) {
  let shadowCatcher = load_shadowCatcherTex(uv, 0);
  let coverage = clamp(shadowCatcher.r, 0.0, 1.0);
  let opacity = max(clamp(shadowCatcher.a / max(coverage, 0.000001), 0.0, 1.0) - (1.0 - shadowCatcherAlpha), 0.0);
  if (coverage > 0.0 || flatBackgroundColor.a > 0.5) {
    let foreground = load_foregroundTex(uv, 0);
    let background = load_catcherBackgroundTex(uv, 0);
    // An opaque flat backdrop also owns primary misses outside the receiver.
    // Its alpha contains catcher coverage plus miss coverage; only the catcher
    // fraction receives shadow. These weights come from the accumulation,
    // independently of the quantized denoising/albedo guide.
    let flatMissCoverage = select(0.0, clamp(background.a - coverage, 0.0, 1.0 - coverage), flatBackgroundColor.a > 0.5);
    var foregroundColor = gradeColor((foreground.rgb + bloomTexel.rgb) * exposure);
    var backgroundColor = gradeColor((background.rgb / max(background.a, 0.000001) + bloomTexel.rgb) * exposure);
    foregroundColor *= 1.0 - toneMappingParams.y * vignetteEdge;
    backgroundColor *= 1.0 - toneMappingParams.y * vignetteEdge;
    if (!hdrOutput) {
      foregroundColor = applyToneMapping(foregroundColor);
      backgroundColor = applyToneMapping(backgroundColor);
    }
    foregroundColor = select(${sdrEncoding === 'srgb' ? 'linearToSrgb(foregroundColor)' : 'pow(max(foregroundColor, vec3f(0.0)), vec3f(1.0 / 2.2))'}, linearToSrgb(foregroundColor), hdrOutput);
    backgroundColor = select(${sdrEncoding === 'srgb' ? 'linearToSrgb(backgroundColor)' : 'pow(max(backgroundColor, vec3f(0.0)), vec3f(1.0 / 2.2))'}, linearToSrgb(backgroundColor), hdrOutput);
    if (flatBackgroundColor.a > 0.5) {
      var unbloomedBackground = gradeColor(background.rgb / max(background.a, 0.000001) * exposure);
      unbloomedBackground *= 1.0 - toneMappingParams.y * vignetteEdge;
      if (!hdrOutput) { unbloomedBackground = applyToneMapping(unbloomedBackground); }
      let encodedUnbloomedBackground = select(${sdrEncoding === 'srgb' ? 'linearToSrgb(unbloomedBackground)' : 'pow(max(unbloomedBackground, vec3f(0.0)), vec3f(1.0 / 2.2))'}, linearToSrgb(unbloomedBackground), hdrOutput);
      let bloomSpill = select(vec3f(0.0), max(backgroundColor - encodedUnbloomedBackground, vec3f(0.0)), bloomIntensity > 0.0);
      backgroundColor = linearToSrgb(max(flatBackgroundColor.rgb, vec3f(0.0))) + bloomSpill;
    }
    // Foreground and catcher are disjoint primary samples, not overlapping
    // alpha layers. Shadow only the catcher background before averaging.
    let shadowAlpha = coverage * opacity;
    let bloomAlpha = clamp(dot(bloomTexel.rgb, vec3f(0.2125, 0.7154, 0.0721)), 0.0, 1.0);
    let foregroundAlpha = max(foreground.a, bloomAlpha * (1.0 - coverage - flatMissCoverage));
    let backgroundAlpha = max(background.a, bloomAlpha * coverage);
    let visibleBackgroundAlpha = (backgroundAlpha - flatMissCoverage) * (1.0 - opacity) + flatMissCoverage;
    let alpha = foregroundAlpha + visibleBackgroundAlpha + shadowAlpha;
    let premultiplied = foregroundColor * foregroundAlpha
      + backgroundColor * visibleBackgroundAlpha
      + shadowCatcherColor * shadowAlpha;
    finalColor = vec4f(premultiplied / max(alpha, 0.000001), alpha);
  }
}

output.color = finalColor;

// output.color = load_bloomTex(uv, 0) * bloomIntensity;
`;
}
export const composeMain = createComposeMain();

// Preserve the existing display composition, but give OIDN a floating-point,
// linear-light image. Alpha is deliberately not used as a second color layer.
export function createCompositeDenoiseColorMain(output = 'output.denoiseColor', input = 'finalColor', sdrEncoding: 'gamma22' | 'srgb' = 'srgb'): string {
  const srgbDecode = 'select(pow((encoded + 0.055) / 1.055, vec3f(2.4)), encoded / 12.92, encoded <= vec3f(0.04045))';
  return /* wgsl */ `
let encoded = max(${input}.rgb, vec3f(0.0));
let displayLinear = ${sdrEncoding === 'srgb' ? srgbDecode : `select(pow(encoded, vec3f(2.2)), ${srgbDecode}, hdrOutput)`};
${output} = vec4f(displayLinear, ${input}.a);

`;
}
export function createCompositeDenoiseAlbedoMain(output = 'output.denoiseAlbedo'): string {
  return /* wgsl */ `// The receiver is invisible: its visible texture is the displayed background,
// not the neutral reflectance used for its lighting estimate. Match the beauty
// reconstruction filter, including mixed foreground/receiver primary samples.
// Exclude the stochastic shadow and bloom so neither is preserved as texture.
let rawAlbedo = load_flatBackgroundMaskTex(uv, 0);
var compositeAlbedo = rawAlbedo.rgb;
if (shadowCatcherEnabled > 0.5 && flatBackgroundColor.a < 0.5) {
  let coverage = clamp(load_shadowCatcherTex(uv, 0).r, 0.0, 1.0);
  let background = load_catcherBackgroundTex(uv, 0);
  if (coverage > 0.0 && background.a > 0.0) {
    var backgroundAlbedo = gradeColor(background.rgb / background.a * exposure);
    backgroundAlbedo *= 1.0 - toneMappingParams.y * vignetteEdge;
    if (!hdrOutput) { backgroundAlbedo = applyToneMapping(backgroundAlbedo); }
    // Background alpha already includes primary catcher coverage. Retain the
    // neutral receiver for its transparent part, without counting coverage twice
    // or adding the stochastic shadow opacity to the texture guide.
    let backgroundWeight = clamp(background.a, 0.0, coverage);
    compositeAlbedo += backgroundWeight * (clamp(backgroundAlbedo, vec3f(0.0), vec3f(1.0)) - vec3f(1.0));
  }
}
${output} = vec4f(clamp(compositeAlbedo, vec3f(0.0), vec3f(1.0)), rawAlbedo.a);
`;
}
export const compositeDenoiseOutputMain = createCompositeDenoiseColorMain() + createCompositeDenoiseAlbedoMain();

export function createCompositeDenoiseDisplayMain(sdrEncoding: 'gamma22' | 'srgb' = 'srgb'): string {
  return /* wgsl */ `
let denoised = load_colorTex(uv, 0);
// Keep the original primary coverage, including transparency. OIDN only
// filters RGB; filtering coverage separately reintroduces silhouette seams.
// The built-in filter weights color and coverage together and may replace it.
let alpha = select(load_composedTex(uv, 0).a, clamp(denoised.a, 0.0, 1.0), denoisedAlpha > 0.5);
let linear = max(denoised.rgb, vec3f(0.0));
let encoded = ${sdrEncoding === 'srgb' ? 'linearToSrgb(linear)' : 'select(pow(linear, vec3f(1.0 / 2.2)), linearToSrgb(linear), hdrOutputEnabled > 0.5)'};
output.color = vec4f(select(vec3f(0.0), encoded, alpha > 0.0), alpha);
`;
}

export const compositeDenoiseDisplayMain = createCompositeDenoiseDisplayMain();

// Shared hit normalization; CPU readback retains its f32 reference path.
export const hdrResolveWGSL = /* wgsl */ `
fn hdr_resolve_component(color: f32, count: f32, hit: f32, minimum_count: f32, rgb: bool) -> f32 {
if (count <= 0.0) {
return 0.0;
}
let total = max(count, minimum_count);
let divisor = select(total, hit, (rgb && (hit > 0.0)));
return (color / divisor);
}
fn hdr_flat_component(color: f32, coverage: f32, flat: bool, rgb: bool) -> f32 {
if ((flat && rgb) && (coverage > 0.0)) {
return (color * coverage);
}
return color;
}
`;
