// SDK conversion only. MuTracer's immutable guides retain their own semantics.
struct Camera {
    inverseProjection: mat4x4f,
    inverseView: mat4x4f,
    previousViewProjection: mat4x4f,
    jitter: vec4f,
    history: vec4u,
}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var sourceMotion: texture_2d<f32>;
@group(0) @binding(2) var validity: texture_2d<u32>;
@group(0) @binding(3) var depth: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var motion: texture_storage_2d<rg32float, write>;
@group(0) @binding(5) var output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var<uniform> camera: Camera;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(depth);
    if (any(id.xy >= size)) { return; }
    let p = vec2i(id.xy);
    let flags = textureLoad(validity, p, 0).x;
    // A correspondence outside the image prevents reuse when the producer has
    // no correspondence. Zero would incorrectly describe a stationary surface.
    var mv = vec2f(size) * 2.0;
    var z = 1e30;
    if ((flags & 1u) != 0u) {
        z = textureLoad(sourceDepth, p, 0).x;
        if ((flags & 2u) != 0u) { mv = textureLoad(sourceMotion, p, 0).xy; }
    } else if (camera.history.x != 0u && camera.history.y == 0u) {
        // Point at infinity: translation cancels, rotation moves the sky.
        let uv = (vec2f(id.xy) + 0.5 + camera.jitter.xy) / vec2f(size);
        let ray = camera.inverseProjection * vec4f(uv.x*2.0-1.0, 1.0-uv.y*2.0, -1.0, 1.0);
        let direction = camera.inverseView * vec4f(ray.xyz / ray.w, 0.0);
        let previous = camera.previousViewProjection * direction;
        if (previous.w > 1e-6) {
            let old = vec2f(previous.x, -previous.y) / previous.w * 0.5 + 0.5;
            mv = (old - uv) * vec2f(size);
        }
    }
    textureStore(depth, p, vec4f(z));
    textureStore(motion, p, vec4f(mv,0.0,0.0));
    // Initialize through wgpu before external writes so its initialization
    // tracker cannot clear the NGX result when the consumer first reads it.
    textureStore(output, p, vec4f(-99.0));
}
