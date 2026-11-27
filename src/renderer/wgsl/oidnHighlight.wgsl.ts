// A single unsupported HDR spike can dominate the model's receptive field.
// Keep its hue, and leave nearby highlights with spatial support intact.
export const oidnHighlightWGSL = /* wgsl */ `
fn oidnRadiancePeak(rgb: vec3f) -> f32 {
  return max(max(rgb.r, rgb.g), rgb.b);
}
fn oidnHighlightLimit(rgb: vec3f, neighbourPeak: f32) -> vec3f {
  let limit = max(8.0, 16.0 * neighbourPeak);
  return rgb * min(1.0, limit / max(oidnRadiancePeak(rgb), 1e-8));
}
`;
