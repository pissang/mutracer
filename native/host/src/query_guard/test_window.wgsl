// Compiled only in the recovery test build. One sequence orders both ASes.
struct QueryWindow {
  next: atomic<u32>, begin: u32, end: u32,
  sceneMisses: atomic<u32>, canaryMisses: atomic<u32>,
}
@group(3) @binding(15) var<storage, read_write> mtWindow: QueryWindow;

fn mtWindowMask(canary: bool) -> u32 {
  let ticket = atomicAdd(&mtWindow.next, 1u);
  if ticket >= mtWindow.begin && ticket < mtWindow.end {
    if canary { atomicAdd(&mtWindow.canaryMisses, 1u); }
    else { atomicAdd(&mtWindow.sceneMisses, 1u); }
    return 0u;
  }
  return 255u;
}
