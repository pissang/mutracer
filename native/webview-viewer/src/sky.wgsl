
struct Params { sun: vec4f, sunWorld: vec4f, size: vec4f, scale: vec4f, ambient: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var transmittanceTable: texture_2d<f32>;
@group(0) @binding(2) var multipleTable: texture_2d<f32>;
@group(0) @binding(3) var skyTable: texture_2d<f32>;
@group(0) @binding(4) var irradianceTable: texture_2d<f32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba32float, write>;
const PI = 3.14159265358979;
const R_GROUND = 6360.0;
const R_TOP = 6460.0;
const CAMERA_ALTITUDE = 0.2;
const RAYLEIGH = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_SCATTERING = 3.996e-3;
const MIE_EXTINCTION = 4.44e-3;
const MIE_G = 0.8;
const OZONE = vec3f(0.65e-3, 1.881e-3, 0.085e-3);
const ALBEDO = vec3f(0.2, 0.18, 0.15);
const T_SIZE = vec2u(256, 64);
const MS_ALTITUDES = 32u;
const SV_SIZE = vec2u(96, 192);

fn discriminant(r: f32, mu: f32, radius: f32) -> f32 { return (radius - r) * (radius + r) + r * r * mu * mu; }
fn hitsGround(r: f32, mu: f32) -> bool { return mu < 0.0 && discriminant(r, mu, R_GROUND) >= 0.0; }
fn distanceToGround(r: f32, mu: f32) -> f32 { return max(-r * mu - sqrt(max(discriminant(r, mu, R_GROUND), 0.0)), 0.0); }
fn distanceToTop(r: f32, mu: f32) -> f32 { return max(-r * mu + sqrt(max(discriminant(r, mu, R_TOP), 0.0)), 0.0); }
fn densities(r: f32) -> vec3f {
  let h = max(r - R_GROUND, 0.0);
  return vec3f(exp(-h / 8.0), exp(-h / 1.2) * 5, max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}
fn extinction(d: vec3f) -> vec3f { return RAYLEIGH * d.x + MIE_EXTINCTION * d.y + OZONE * d.z; }
fn altitudeAt(x: f32) -> f32 { return x * x * (R_TOP - R_GROUND); }
fn altitudeCoord(h: f32) -> f32 { return sqrt(clamp(h / (R_TOP - R_GROUND), 0.0, 1.0)); }
fn fetchLinear(table: texture_2d<f32>, p: vec2f) -> vec3f {
  let size = vec2i(textureDimensions(table));
  let q = clamp(p, vec2f(0.0), vec2f(size - 1));
  let i = min(vec2i(floor(q)), max(size - 2, vec2i(0)));
  let f = clamp(q - vec2f(i), vec2f(0.0), vec2f(1.0));
  let j = min(i + 1, size - 1);
  let a = textureLoad(table, i, 0).rgb;
  let b = textureLoad(table, vec2i(j.x, i.y), 0).rgb;
  let c = textureLoad(table, vec2i(i.x, j.y), 0).rgb;
  let d = textureLoad(table, j, 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn transmittanceTo(r: f32, mu: f32) -> vec3f {
  return fetchLinear(transmittanceTable, vec2f((clamp(mu, -1.0, 1.0) + 1.0) * 0.5 * f32(T_SIZE.x - 1u), altitudeCoord(r - R_GROUND) * f32(T_SIZE.y - 1u)));
}
fn cornetteShanks(nu: f32) -> f32 {
  let g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + nu * nu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * nu, 1.5));
}
struct March { radiance: vec3f, throughput: vec3f }
fn march(origin: vec3f, dir: vec3f, steps: u32, full: bool, skyIrradiance: vec3f) -> March {
  let r = length(origin);
  let mu = dot(origin, dir) / r;
  let ground = hitsGround(r, mu);
  var len = distanceToTop(r, mu);
  if (ground) { len = distanceToGround(r, mu); }
  let nu = dot(dir, params.sun.xyz);
  var rayleighPhase = 1.0 / (4.0 * PI);
  var miePhase = rayleighPhase;
  if (full) { rayleighPhase = 3.0 / (16.0 * PI) * (1.0 + nu * nu); miePhase = cornetteShanks(nu); }
  var result = March(vec3f(0.0), vec3f(0.0));
  var view = vec3f(1.0);
  var previous = 0.0;
  for (var i = 0u; i < steps; i++) {
    let s = f32(i + 1u) / f32(steps);
    let next = len * s * s;
    let dt = next - previous;
    let p = origin + dir * (0.5 * (previous + next));
    previous = next;
    let pr = length(p);
    let d = densities(pr);
    let e = extinction(d);
    let sunT = transmittanceTo(pr, dot(p, params.sun.xyz) / pr);
    let scatterR = RAYLEIGH * d.x;
    let scatterM = MIE_SCATTERING * d.y;
    var ms = vec3f(0.0);
    if (full) { ms = fetchLinear(multipleTable, vec2f(altitudeCoord(pr - R_GROUND) * f32(MS_ALTITUDES - 1u), 0.0)); }
    let source = sunT * (scatterR * rayleighPhase + scatterM * miePhase) + (scatterR + scatterM) * ms;
    let segment = exp(-e * dt);
    let weight = (1.0 - segment) / max(e, vec3f(1e-9));
    result.radiance += view * source * weight;
    result.throughput += view * (scatterR + scatterM) * weight;
    view *= segment;
  }
  if (ground) {
    let p = origin + dir * len;
    let pr = length(p);
    let cosSun = dot(p, params.sun.xyz) / pr;
    let irradiance = transmittanceTo(pr, cosSun) * max(cosSun, 0.0) + skyIrradiance;
    result.radiance += view * ALBEDO / PI * irradiance;
  }
  return result;
}
fn elevationAt(row: f32) -> f32 {
  let x = row / f32(SV_SIZE.y - 1u) * 2.0 - 1.0;
  return sign(x) * x * x * (PI / 2.0);
}
fn elevationCoord(e: f32) -> f32 {
  let x = sign(e) * sqrt(abs(e) / (PI / 2.0));
  return clamp((x + 1.0) * 0.5, 0.0, 1.0) * f32(SV_SIZE.y - 1u);
}
@compute @workgroup_size(8, 8)
fn transmittance(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= T_SIZE)) { return; }
  let mu = f32(id.x) / f32(T_SIZE.x - 1u) * 2.0 - 1.0;
  let r = R_GROUND + altitudeAt(f32(id.y) / f32(T_SIZE.y - 1u));
  if (hitsGround(r, mu)) { textureStore(output, vec2i(id.xy), vec4f(0.0, 0.0, 0.0, 1.0)); return; }
  let len = distanceToTop(r, mu);
  var depth = vec3f(0.0);
  for (var i = 0u; i < 48u; i++) {
    let t = (f32(i) + 0.5) / 48.0 * len;
    depth += extinction(densities(sqrt(t * t + 2.0 * r * mu * t + r * r))) * (len / 48.0);
  }
  textureStore(output, vec2i(id.xy), vec4f(exp(-depth), 1.0));
}
@compute @workgroup_size(8, 8)
fn multiple(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= MS_ALTITUDES || id.y > 0u) { return; }
  let r = R_GROUND + altitudeAt(f32(id.x) / f32(MS_ALTITUDES - 1u));
  var second = vec3f(0.0);
  var transfer = vec3f(0.0);
  for (var i = 0u; i < 64u; i++) {
    let mu = 1.0 - 2.0 * (f32(i) + 0.5) / 64.0;
    let phi = f32(i) * PI * (3.0 - sqrt(5.0));
    let s = sqrt(1.0 - mu * mu);
    let result = march(vec3f(0.0, r, 0.0), vec3f(s * cos(phi), mu, s * sin(phi)), 20u, false, vec3f(0.0));
    second += result.radiance / 64.0;
    transfer += result.throughput / 64.0;
  }
  textureStore(output, vec2i(id.xy), vec4f(second / (1.0 - transfer), 1.0));
}
@compute @workgroup_size(8, 8)
fn skyView(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= SV_SIZE)) { return; }
  let e = elevationAt(f32(id.y));
  let phi = f32(id.x) / f32(SV_SIZE.x - 1u) * PI;
  var sky = vec3f(0.0);
  if (params.size.w > 0.0) { sky = textureLoad(irradianceTable, vec2i(0), 0).rgb; }
  let result = march(vec3f(0.0, R_GROUND + CAMERA_ALTITUDE, 0.0), vec3f(cos(e) * cos(phi), sin(e), cos(e) * sin(phi)), 40u, true, sky);
  textureStore(output, vec2i(id.xy), vec4f(result.radiance, 1.0));
}
@compute @workgroup_size(8, 8)
fn irradiance(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 2u || id.y > 0u) { return; }
  var sky = vec3f(0.0);
  for (var i = 0u; i < 128u; i++) {
    let e = (f32(i) + 0.5) / 128.0 * (PI / 2.0);
    let weight = 2.0 * sin(e) * cos(e) * (PI / 2.0 / 128.0) * (PI / 48.0);
    for (var j = 0u; j < 48u; j++) {
      let phi = (f32(j) + 0.5) / 48.0 * PI;
      sky += fetchLinear(skyTable, vec2f(phi / PI * f32(SV_SIZE.x - 1u), elevationCoord(e))) * weight;
    }
  }
  if (id.x == 0u) { textureStore(output, vec2i(id.xy), vec4f(sky, 1.0)); return; }
  let sunT = transmittanceTo(R_GROUND + CAMERA_ALTITUDE, params.sun.y);
  let luma = vec3f(0.2126, 0.7152, 0.0722);
  let horizontal = dot(sky, luma) + dot(sunT, luma) * max(params.sun.y, 0.0);
  let scale = 3.141592653589793 / sqrt(max(horizontal, 0.488 * 1e-3) * 0.488);
  textureStore(output, vec2i(id.xy), vec4f(sunT, scale));
}
fn mapDirection(texel: vec2f) -> vec3f {
  let theta = texel.y / params.size.y * PI;
  let phi = texel.x / params.size.x * 2.0 * PI;
  return vec3f(-sin(theta) * cos(phi), cos(theta), -sin(theta) * sin(phi));
}
@compute @workgroup_size(8, 8)
fn map(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(params.size.xy))) { return; }
  let texel = vec2f(id.xy) + 0.5;
  let dir = mapDirection(texel);
  let rawRelative = abs(atan2(dir.z, dir.x) - params.sun.w);
  let wrapped = rawRelative - floor(rawRelative / (2.0 * PI)) * (2.0 * PI);
  let relative = min(wrapped, 2.0 * PI - wrapped);
  let e = asin(clamp(dir.y, -1.0, 1.0));
  var radiance = fetchLinear(skyTable, vec2f(relative / PI * f32(SV_SIZE.x - 1u), elevationCoord(e)));
  let sun = textureLoad(irradianceTable, vec2i(1, 0), 0);
  let radius = params.sunWorld.w;
  let texelAngle = PI / params.size.y;
  if (acos(clamp(dot(dir, params.sunWorld.xyz), -1.0, 1.0)) < radius + 3.0 * texelAngle / max(sqrt(1.0 - dir.y * dir.y), 0.05)) {
    var coverage = 0.0;
    for (var y = 0u; y < 6u; y++) { for (var x = 0u; x < 6u; x++) {
      let d = mapDirection(texel - 0.5 + (vec2f(f32(x), f32(y)) + 0.5) / 6.0);
      let angle = 2.0 * asin(min(length(d - params.sunWorld.xyz) * 0.5, 1.0));
      let t = angle / radius;
      if (t < 1.0) { coverage += 1.0 - 0.6 * (1.0 - sqrt(1.0 - t * t)); }
    } }
    let solidAngle = 2.0 * PI * (1.0 - cos(radius));
    radiance += coverage / 36.0 / (solidAngle * (1.0 - 0.6 / 3.0)) * sun.rgb;
  }
  textureStore(output, vec2i(id.xy), vec4f(radiance * sun.a * params.scale.xyz + params.ambient.xyz, 1.0));
}
