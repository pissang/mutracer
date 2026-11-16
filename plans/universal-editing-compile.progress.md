# Universal editing compile progress

- Baseline: `a92c86951e55274dae64271c8bbbb887309e760b`.
- Branch/worktree: `perf/universal-editing-compile`, `C:/Dev/mutracer`.
- Plan: [universal-editing-compile.md](universal-editing-compile.md).
- Evidence/report: `C:/Dev/mutracer-evidence/20261116-universal-editing/REPORT.md`.
- Hardware: Windows, i9-13900H, RTX 4060 Laptop, NVIDIA 617.42, Chrome 157.0.8103.78.
- Compiler references: Dawn `106245fa2b9e1cf8b59b1bb8e010af3c7ca8b600`, Chrome DXC DLL 1.9.2609.0.

| Task | Current state / commit |
| --- | --- |
| Actual compiler profile | Complete; HLSL/DXIL exports, exact offline DXIL except hash, time reports/traces and debug inlining chains in evidence |
| Cold compilation | Partial, `d48e356f`: shared surface/opacity + surface-slot loop; final isolated 24.825 / 25.151 s, target <=10 s not achieved |
| Early reusable signature | Implemented, `d48e356f`: eligible device-init start, pending/ready reuse, all material/light/query capabilities, runtime vertices; bounded atlas and BLAS families |
| Viewer | Final all-method-counted runs: first sample 14.178 / 14.137 s, universal ready 28.872 / 28.733 s; baseline 13.750 / 13.790 s and 38.752 / 39.060 s. Forty switches: one >500 ms each, P95 137.3 /147.6 ms, zero trace compiles; four auxiliary pipeline creations. Model swap preserves actual universal object |
| HDR | Final all40 samples and nine cube/tangent/displacement cases, positive bevel and two-mesh/all-texture case: 64 spp, offset0, all bit-identical, confirmed universal serving. Raw files/audits in evidence |
| Persistent cache | Sphere then cube: identical source bytes, 25.467 s cold /88.7 ms warm; `cache-sphere/`, `cache-cube/` |
| Checks | Four typechecks and full library suite pass (202 files, 2979 tests, two platform skips); `checks.json`, `check-test.log` |
| Documentation | Usage/API/design changes in `d48e356f`; final capacity clarification and plan snapshot accompany this file. Prose reviewed separately |

Remaining work, in order:
1. Reach <=10 s cold. Start with `solo-final-1/` and `solo-baseline-viewer-1/`: DXC ~16 s plus ~8.5 s later pipeline work. Opacity copies fell3→2, but NEE and catcher visibility still have separate copies. Pick the next mechanism from this profile; no material-pass/wavefront split has been implemented.
2. Validate changed Metal scheduling/capacities on Mac, including the prior ~4.5 s compile target; no Mac hardware was available here.
3. Repeat WebGL GPU A/B where its baseline shader becomes ready; this attempt timed out at120 s before reaching the candidate (`webgl-final/error.txt`). GLSL and shared packing are unchanged.

Bounds/limitations:
- Canonical NUM_MAPS256 is12 KiB; existing rounding in tens means >250 entries can compile another capacity. Atlas high-water capacity does not shrink on model replacement.
- BVH2 plus the requested BLAS family share a kernel; switching families or algorithm/quality/binding settings can compile. Full all-layout trial costs47.7–48.3 s; see report for the complete signature audit.
- Final first sample is ~0.39 s (2.8%) later than the paired baseline; earlier prefetch reduces ready time by~10 s, not the kernel's intrinsic compile time.
- Four auxiliary creations during the initial graph switches are display/AOV initialization, not trace recompilation. Mac and WebGL GPU comparisons remain unverified.
- Rejected narrower ~14.7 s kernel omitted catcher/bevel coverage; do not present it as final. Rejected packed MXResult/private scratch/tap/scalar-loop trials remain only in external evidence.

Handoff: source is committed and web evidence is complete within these limits. Use `REPORT.md`, `final-summary.json`, `canonical-signature.json` and `commits.json`; only inspect archived trial directories for the specific follow-up being pursued. The cold-compile objective remains open.
