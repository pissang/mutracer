
struct Params {
  size: vec2u, samples: f32, exposure: f32,
  toneMode: u32, outputKind: u32, flags: u32, originalSamples: f32,
  grading: vec4f, effects: vec4f, catcher: vec4f, background: vec4f, scene: vec4u
}
struct ShadowCatcherAccumulation { mask: vec4f, background: vec4f, moments: vec4f }
@group(0) @binding(0) var<storage, read> filtered: array<vec4f>;
@group(0) @binding(1) var<storage, read> original: array<vec4f>;
@group(0) @binding(2) var<storage, read> normals: array<vec4f>;
@group(0) @binding(3) var<storage, read> albedos: array<vec4f>;
@group(0) @binding(4) var<storage, read> shadows: array<ShadowCatcherAccumulation>;
@group(0) @binding(5) var bloom: texture_2d<f32>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var outputImage: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(8) var normalizedImage: texture_storage_2d<rgba32float, write>;
var<private> toneMappingParams: vec4f;
var<private> colorGradingParams: vec4f;


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

fn linearToSrgb(color: vec3f) -> vec3f {
  let linear = max(color, vec3f(0.0));
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

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

fn indexOf(uv: vec2i) -> u32 { return (params.size.y - 1u - u32(uv.y)) * params.size.x + u32(uv.x); }
fn colorTexRegion() -> vec2u { return params.size; }
fn load_colorTex(uv: vec2i, level: i32) -> vec4f {
  let i = indexOf(uv);
  var rgba = filtered[i] / params.samples;
  let coverage = albedos[i].a / params.originalSamples;
  if (coverage > 0.0) { rgba = vec4f(rgba.rgb / coverage, rgba.a); }
  return rgba;
}
fn rawColor(uv: vec2i) -> vec3f {
  let i = indexOf(uv);
  let hit = albedos[i].a;
  return original[i].rgb / select(params.originalSamples, hit, hit > 0.0);
}
fn load_flatBackgroundMaskTex(uv: vec2i, level: i32) -> vec4f { return albedos[indexOf(uv)] / params.originalSamples; }
fn load_shadowCatcherTex(uv: vec2i, level: i32) -> vec4f {
  if (params.scene.x == 0u) { return vec4f(0.0); }
  let shadow = shadows[indexOf(uv)];
  let total = params.originalSamples;
  let coverage = shadow.mask.r / total;
  let opacity = select(0.0, shadow.moments.z / max(shadow.moments.w, 0.000001), shadow.moments.w > 0.0);
  return vec4f(shadow.mask.rgb / total, coverage * opacity);
}
fn correctLayer(value: vec4f, uv: vec2i, background: bool) -> vec4f {
  if (params.scene.y == 0u) { return value; }
  let raw = rawColor(uv);
  let color = load_colorTex(uv, 0).rgb;
  if (all(raw == color)) { return value; }
  // Same correction as customDenoiseLayersMain; preserve each layer's coverage.
  let usable = abs(raw) > vec3f(0.000001);
  let scale = select(vec3f(1.0), color / select(vec3f(1.0), raw, usable), usable);
  let residual = select(color - raw, vec3f(0.0), usable);
  return vec4f(value.rgb * scale + residual * select(1.0, value.a, background), value.a);
}
fn load_foregroundTex(uv: vec2i, level: i32) -> vec4f {
  let i = indexOf(uv);
  let shadow = shadows[i];
  let hit = max(albedos[i].a - shadow.mask.b, 0.0);
  return correctLayer(vec4f((original[i].rgb - shadow.background.rgb) / select(params.originalSamples, hit, hit > 0.0),
    clamp((original[i].a - shadow.mask.g) / params.originalSamples, 0.0, 1.0)), uv, false);
}
fn load_catcherBackgroundTex(uv: vec2i, level: i32) -> vec4f {
  return correctLayer(shadows[indexOf(uv)].background / params.originalSamples, uv, true);
}
fn load_bloomTex(uv: vec2i, level: i32) -> vec4f { return textureLoad(bloom, uv, 0); }
struct FSOutput { color: vec4f }
@compute @workgroup_size(8,8)
fn normalize(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  textureStore(normalizedImage, id.xy, load_colorTex(vec2i(id.xy), 0));
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let uv = vec2i(id.xy);
  toneMappingParams = vec4f(f32(params.toneMode), params.effects.x, 0.0, 0.0);
  colorGradingParams = params.grading;
  let bloomIntensity = params.effects.y;
  let exposure = params.exposure;
  let hdrOutputEnabled = 0.0;
  let flatBackgroundColor = params.background;
  let shadowCatcherEnabled = f32(params.scene.x);
  let shadowCatcherColor = params.catcher.rgb;
  let shadowCatcherAlpha = params.catcher.a;
  var output: FSOutput;


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
  linearToSrgb(gradedColor),
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
      linearToSrgb(unbloomedColor),
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
    foregroundColor = select(linearToSrgb(foregroundColor), linearToSrgb(foregroundColor), hdrOutput);
    backgroundColor = select(linearToSrgb(backgroundColor), linearToSrgb(backgroundColor), hdrOutput);
    if (flatBackgroundColor.a > 0.5) {
      var unbloomedBackground = gradeColor(background.rgb / max(background.a, 0.000001) * exposure);
      unbloomedBackground *= 1.0 - toneMappingParams.y * vignetteEdge;
      if (!hdrOutput) { unbloomedBackground = applyToneMapping(unbloomedBackground); }
      let encodedUnbloomedBackground = select(linearToSrgb(unbloomedBackground), linearToSrgb(unbloomedBackground), hdrOutput);
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

  if (params.outputKind == 1u) {
    let n = normals[indexOf(uv)];
    let a = select(0.0, 1.0, dot(n.rgb, n.rgb) > 0.1);
    output.color = vec4f(select(vec3f(0.0), n.rgb / params.originalSamples * 0.5 + 0.5, a > 0.0), a);
  } else if (params.outputKind == 2u) {
    let a = load_flatBackgroundMaskTex(uv, 0);
    output.color = vec4f(a.rgb, clamp(a.a, 0.0, 1.0));
  } else if (params.outputKind == 4u) { output.color = load_shadowCatcherTex(uv, 0); }


  if ((params.flags & 1u) == 0u) { output.color.a = 1.0; }
  if ((params.flags & 2u) != 0u) { output.color = vec4f(output.color.rgb * output.color.a, output.color.a); }
  textureStore(outputImage, id.xy, output.color);
}