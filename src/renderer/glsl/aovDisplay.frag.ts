import {FragmentShader, Shader} from '../shader.js';
export default new FragmentShader({
  name: 'AOV display', outputs: ['color'],
  uniforms: {
    geometry: Shader.uniform('sampler2D'), position: Shader.uniform('sampler2D'),
    diffuse: Shader.uniform('sampler2D'), specular: Shader.uniform('sampler2D'),
    identity: Shader.uniform('usampler2D'), motion: Shader.uniform('sampler2D'),
    normalDepth: Shader.uniform('sampler2D'), centerPosition: Shader.uniform('sampler2D'),
    kind: Shader.uniform('int'), samples: Shader.uniform('float'),
    mapping: Shader.uniform('vec4'), idComponent: Shader.uniform('int')
  },
  main: /* glsl */ `
uint displayHash(uint v) {
  v = (v ^ (v >> 16u)) * 0x7feb352du;
  v = (v ^ (v >> 15u)) * 0x846ca68bu;
  return v ^ (v >> 16u);
}
vec3 srgb(vec3 rgb) {
  return mix(1.055 * pow(max(rgb, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    12.92 * rgb, lessThanEqual(rgb, vec3(0.0031308)));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 point = texelFetch(position, p, 0), g = texelFetch(geometry, p, 0);
  float inv = 1.0 / max(point.w, 1.0), alpha = point.w / max(samples, 1.0);
  vec3 color = vec3(0.0);
  if (kind == 0) {
    color = vec3(clamp((g.x * inv - mapping.x) / (mapping.y - mapping.x), 0.0, 1.0));
  } else if (kind == 1) {
    color = clamp(point.xyz * inv / mapping.z * .5 + .5, 0.0, 1.0);
  } else if (kind == 2) {
    color = clamp(g.yzw * inv, 0.0, 1.0);
  } else if (kind == 3 || kind == 4) {
    vec4 r = kind == 3 ? texelFetch(diffuse, p, 0) : texelFetch(specular, p, 0);
    alpha = r.w / max(samples, 1.0);
    color = srgb(clamp(r.xyz / max(r.w, 1.0), 0.0, 1.0));
  } else if (kind == 5) {
    uvec4 ids = texelFetch(identity, p, 0);
    alpha = ids.x == 0xffffffffu ? 0.0 : 1.0;
    uint h = displayHash(ids[idComponent]);
    color = .2 + .8 * vec3(float(h & 255u), float((h >> 8u) & 255u),
      float((h >> 16u) & 255u)) / 255.0;
  } else if (kind >= 9) {
    vec4 nd = texelFetch(normalDepth, p, 0), cp = texelFetch(centerPosition, p, 0);
    alpha = cp.w;
    if (kind == 9) color = clamp(nd.xyz * .5 + .5, 0.0, 1.0);
    else if (kind == 10) color = vec3(clamp((nd.w - mapping.x) / (mapping.y - mapping.x), 0.0, 1.0));
    else color = clamp(cp.xyz / mapping.z * .5 + .5, 0.0, 1.0);
  } else {
    vec4 m = texelFetch(motion, p, 0);
    alpha = m.w == 3.0 ? 1.0 : 0.0;
    float magnitude = length(m.xy), hue = 0.0;
    if (magnitude > 0.0) hue = fract(atan(m.y, m.x) / 6.28318530718 + 1.0);
    vec3 v = abs(fract(vec3(hue) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    color = clamp(v - 1.0, 0.0, 1.0) * clamp(magnitude / mapping.w, 0.0, 1.0);
  }
  if (alpha <= 0.0) color = vec3(0.0);
  out_color = vec4(color, clamp(alpha, 0.0, 1.0));
}`});
