@group(0) @binding(0) var sourceGuide: texture_2d<f32>;
@group(0) @binding(1) var sdkGuide: texture_storage_2d<GUIDE_FORMAT, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(sdkGuide);
    if (any(id.xy >= size)) { return; }
    let p = vec2i(id.xy);
    let record = textureLoad(sourceGuide, p, 0);
    textureStore(sdkGuide, p, GUIDE_VALUE);
}
