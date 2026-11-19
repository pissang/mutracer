fn mtCanaryRendezvous() {
  workgroupBarrier();
}

override MT_CHECK_REPLAY_START: bool = false;
@group(3) @binding(4) var mtCanaryAS: acceleration_structure;
@group(3) @binding(5) var<storage, read_write> mtEpochFlag: atomic<u32>;

fn mtCheckWorkgroup() {
  let ray = Ray(vec3f(0., 0., 3.), vec3f(0., 0., -1.));
  let hit = mtTrace(mtCanaryAS, true, ray, 100., false, -1, -1, -1, true, false);
  if hit.kind == RAY_QUERY_INTERSECTION_NONE {
    atomicOr(&mtEpochFlag, 1u);
  }
}

@compute @workgroup_size(8, 4, 1)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  if MT_CHECK_REPLAY_START || ((group.x | group.y) & 1u) == 0u {
    if lane == 0u { mtCheckWorkgroup(); }
    mtCanaryRendezvous();
  }
  mtBeauty(id);
  mtCanaryRendezvous();
  if lane == 0u { mtCheckWorkgroup(); }
}
