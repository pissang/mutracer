@group(0) @binding(0) var reconstructed: texture_2d<f32>;
@group(0) @binding(1) var validity: texture_2d<u32>;
@group(0) @binding(2) var<storage,read> original: array<vec4f>;
@group(0) @binding(3) var<storage,read_write> output: array<vec4f>;
@group(0) @binding(4) var<storage,read> albedo: array<vec4f>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(reconstructed);
    if (any(id.xy >= size)) { return; }
    let index = id.x + (size.y-1u-id.y)*size.x;
    let raw = original[index];
    let flags = textureLoad(validity, vec2i(id.xy), 0).x;
    let filtered = textureLoad(reconstructed, vec2i(id.xy), 0).rgb;
    // Preserve raw coverage/background and material layers whose reflectance
    // contract has not been validated. Basic transmission remains enabled.
    let supported = (flags & 161u) == 129u;
    // NGX reconstructs conditional surface radiance. MuTracer's custom result
    // is averaged raw radiance; Display divides by primary coverage once.
    let coverage = clamp(albedo[index].a, 0.0, 1.0);
    output[index] = vec4f(select(raw.rgb, filtered * coverage, supported), raw.a);
}
