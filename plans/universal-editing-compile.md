# Universal editing compile

Baseline: `a92c86951e55274dae64271c8bbbb887309e760b`.
Branch: `perf/universal-editing-compile`, worktree `C:/Dev/mutracer`.
Evidence: `C:/Dev/mutracer-evidence/20261116-universal-editing/`.
Current state: [progress](universal-editing-compile.progress.md).

1. Export the actual D3D12 HLSL, confirm compiler/version/flags, reproduce browser
   timings offline, and profile optimization passes and expanded code before
   choosing a compile-time optimization. Compare lean, lobe and universal kernels.
2. Implement and measure the selected optimization, preserving every rendering
   mechanism and exact HDR behavior. Target <=10 s cold, preferably <=5 s.
3. Audit every scene-dependent signature input. Fix bounded capacities or use
   runtime data, retaining safe fallbacks. Compile immediately after device setup;
   reuse pending/ready pipelines across scenes and model loads. Measure contention
   against the first frame. Apply the same signature rules on Metal.
4. Verify 40 MaterialX samples at 64 samples and fixed sequence offset, vertex
   layouts, displacement, opacity/emission, another scene, viewer switches and
   model reuse, GPU timings, two salted cold runs per retained comparison, and
   all required repository checks. Mark Mac measurements unverified if unavailable.
5. Update usage/design documentation, review edited prose separately, commit
   coherent changes and report evidence, rejected directions and remaining limits.
