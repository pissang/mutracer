
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
