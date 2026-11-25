fn mtCanaryRendezvous() {
  workgroupBarrier();
}

override MT_CHECK_REPLAY_START: bool = false;
@group(3) @binding(4) var mtCanaryAS: acceleration_structure;
@group(3) @binding(5) var<storage, read_write> mtEpochFlag: atomic<u32>;

fn mtCheckWorkgroup() {
  let ray = Ray(vec3f(0., 0., 3.), vec3f(0., 0., -1.));
  var miss: MtHit;
  let hit = mtTrace(mtCanaryAS, true, ray, 100., false, -1, -1, -1, true, false, miss, 0u);
  if hit.kind == RAY_QUERY_INTERSECTION_NONE {
    atomicOr(&mtEpochFlag, 1u);
  }
}
