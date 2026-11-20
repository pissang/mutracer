struct Options {
    view: mat4x4f,
    transform: vec4u,
}
@group(0) @binding(0) var inputGuide: texture_2d<f32>;
@group(0) @binding(1) var outputGuide: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> options: Options;

@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(outputGuide))) { return; }
    let p = vec2i(id.xy);
    let guide = textureLoad(inputGuide, p, 0);
    var mapped = guide.xyz;
    if (options.transform.x == 0u) {
        mapped = clamp(mapped / (vec3f(1.0) + mapped), vec3f(0.0), vec3f(1.0));
    } else {
        mapped = (options.view * vec4f(mapped, 0.0)).xyz;
    }
    textureStore(outputGuide, p, vec4f(mapped, guide.w));
}
