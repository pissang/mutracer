# Metal HWRT silent-miss guard

Metal HWRT can return no intersection for every ray query during a period of
time while the command buffer still completes without an error. Affected
samples see an empty scene, so images become brighter and runs stop being
byte-identical. It reproduces in a standalone Metal program with one triangle,
an immutable acceleration structure and one known-hit ray, without wgpu or
MuTracer, so its cause lies below the SDK and is not identified. It has been
observed on an Apple M4 Max with macOS 27.0.1; other devices and systems have
not been checked.

A failure is a window, not a per-query fault. Inside it, queries miss on every
acceleration structure and pipeline, across dispatch and encoder boundaries,
and an immediate re-query of the same ray also misses. A window can cover
only part of a dispatch, such as its first rows, or many consecutive
dispatches. Idle gaps between sampling buffers combined with other GPU work
raise the rate. GPU Hang errors are a separate defect: they report an
execution error and use the explicit-error retry described below.

## Silent-miss guard

`native/host/src/query_guard.rs` protects the ordinary beauty pipeline of Metal
HWRT targets. Paths below are relative to `native/host/src/`.

- **Detection.** `instrument` renames the AOT beauty entry to `mtBeauty` and
  adds an 8×4 entry from `workgroup_canary.wgsl`. After a workgroup finishes
  its pixels, one lane traces a fixed ray against a private one-triangle
  acceleration structure through the scene's own `mtTrace`, so no second copy
  of the traversal code is compiled. A miss sets a sticky flag for the current
  checkpoint epoch. The kernel never reads the flag and never gates its
  accumulation writes. A quarter of the workgroups also check before tracing;
  replays check every workgroup before and after.
- **Checkpoints.** About once a second, at a sampling-flight boundary, the
  four accumulation buffers are copied. The flag is confirmed before a newer
  checkpoint replaces this one, before samples are credited at the end of a
  blocking call, and before any readback or export. Healthy batches do not
  wait for the flag.
- **Replay.** A set flag restores the checkpoint and replays every sample after
  it with the original sample indices, using the replay pipeline that checks
  at both ends, then reads the flag again. Pure silent misses may replay
  repeatedly within one 10-second deadline. Explicit, recoverable execution
  errors allow at most 12 retries inside that deadline; `SubmissionsIgnored`
  renews the observed queue. Device loss and failures that cannot be verified
  are returned. The result is byte-identical to an undisturbed render.
- **Submission.** Each device has at most one sampling command buffer in
  flight. Short batches prepare the next buffer while the GPU runs and commit
  it once the previous one retires; long batches keep the four-dispatch
  default. Physical batch size adapts between 4, 8 and 32 dispatches to stay
  near 16 ms of GPU time and returns to 4 after a repair.
- **Fallback.** The replay and test pipelines are compiled with the beauty
  pipeline and cached on the target. If the template cannot be instrumented,
  the original pipeline is used without protection and a warning is logged;
  `query_guard/template_tests.rs` instruments the Chess and SanMiguel templates
  so generator changes fail in CI instead.

The design follows from the failure shape. Application-side workarounds
(submission pacing, parameter upload methods, fences, binding slots, MSL
versions, warm-up queries, queue priority, AS build options, in-kernel
retries) all produced verified misses. Probes outside the beauty dispatch, at
the start or end of a command buffer, missed windows that lay inside a
dispatch. Re-checking missed rays fails because the re-check falls into the
same window. Gating accumulation writes on the flag cost about 1.6% of kernel
time, and a second full render doubles the cost. Moving tracing to the
fragment stage avoids the related Hang but was rejected for the product.

## Costs and limits

- About 2% render time on SanMiguel-sized scenes and negligible cost on short
  batches such as Chess, measured against the unguarded renderer on an M4 Max.
  The remaining cost is mostly the idle gap between long sampling batches.
- A cold shader cache compiles one more megakernel pipeline per scene or target
  shader.
- A checkpoint holds one extra copy of the four accumulation buffers.
- A window shorter than the interval between workgroup checks can pass
  undetected. Injected windows that escaped changed at most a few dozen pixels
  in a single sample.
- Caustics targets have separate flight checkpoints for explicit errors only.
  Surface AOV/depth/picking passes, frame-input producers and
  host queues that the SDK does not observe have no checkpoint replay. A
  detected miss on an unobserved queue returns an error.

Evaluate changes against the window model: a test fault must make every query
miss between two points of a global query sequence, including the guard's own
queries. A fault that drops only selected queries cannot be caught by any check
that uses the same hardware and is not a valid acceptance test. Interleave
candidates with the unguarded renderer in fresh processes. A
stop-at-first-failure count is not a rate, and a run with no failures does not
prove a fix. The recovery-test build injects windows through
`query_guard/test_window.wgsl`; see `query_guard/tests.rs` and
`context/recovery_tests.rs`. Keep standalone Metal probes outside the
repository.

User-facing behavior and costs are in the [native README](../../README.md).
Command-buffer status, dispatch audits and the HWRT loop test are described in
[Metal HWRT sample miss](../../CONTRIBUTING.md#metal-hwrt-sample-miss).
