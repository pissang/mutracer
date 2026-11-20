@group(0) @binding(0) var<storage, read> source: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> destination: array<vec4f>;
@group(0) @binding(2) var<uniform> region: vec4u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let extent = region.xy;
    let size = extent * 2u;
    if (any(id.xy >= size)) { return; }
    let pixel = id.xy / 2u;
    let stride = region.z;
    let dst = (id.x + id.y * size.x) * stride;
    let src = (pixel.x + pixel.y * extent.x) * stride;
    for (var lane = 0u; lane < stride; lane++) {
        destination[dst + lane] = source[src + lane];
    }
}
