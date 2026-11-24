// Convert bottom-first native sample sums to top-first history inputs.
@group(0) @binding(0) var<uniform> size: vec2u;
@group(0) @binding(1) var<storage,read> colors: array<vec4f>;
@group(0) @binding(2) var<storage,read> albedos: array<vec4f>;
@group(0) @binding(3) var<storage,read> normals: array<vec4f>;
@group(0) @binding(4) var<storage,read_write> hdr: array<vec4f>;
@group(0) @binding(5) var<storage,read_write> albedo: array<vec4f>;
@group(0) @binding(6) var<storage,read_write> normal: array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
    if (any(g.xy>=size)) { return; }
    let dst=g.y*size.x+g.x;
    let src=(size.y-1u-g.y)*size.x+g.x;
    let c=colors[src]; let n=normals[src]; let a=albedos[src];
    let total=max(n.w,1.0);
    hdr[dst]=vec4f(c.rgb/select(total,a.w,a.w>0.0),c.a/total);
    albedo[dst]=vec4f(a.rgb/total,clamp(a.w/total,0.0,1.0));
    normal[dst]=select(vec4f(0),vec4f(n.rgb/total*0.5+0.5,1),dot(n.rgb,n.rgb)>0.1);
}
