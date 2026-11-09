# Megakernel value layouts

Changes to `OpenPbrResolvedMaterial`, `OpenPbrPreparedBsdf`, `SurfaceInteraction`
and `Path` need both the CPU layout contract and the informational GPU benchmark:

```bash
npx vitest run tests/unit/shaderValueLayouts.test.ts
node scripts/benchmark-megakernel.mjs --repeats 5 --output /tmp/megakernel.json
```

Compare the same machine, browser, scene and sample stream before and after the
change. Keep raw repeats; use GPU timestamps alongside wall time to distinguish
GPU work from preparation and scheduling noise. Performance has no pass/fail
threshold. A layout-contract update records a deliberate compiler-input change;
it does not establish that the new layout is fast. Member reordering still needs
the GPU comparison even when the size contract passes.

## Contracts

The test reflects generated default and graph-specialized WGSL with compact and
uncompressed vertices, with and without scene alpha. The frame profiles below
include scene alpha; omitting its mode removes one resolved-material member
without changing these byte totals:

| Value type | Frames off: members / bytes | Tangent and coat frames: members / bytes |
| --- | --- | --- |
| `OpenPbrResolvedMaterial` | 41 / 272 | 51 / 400 |
| `OpenPbrPreparedBsdf` | 22 / 528 | 25 / 736 |
| `SurfaceInteraction` | 21 / 192 | 26 / 272 |
| `Path` | 10 / 96 | 10 / 96 |

Boolean counts are also pinned: replacing a boolean with an equal-sized integer
can change compilation even when member count and total size remain unchanged.
These are WGSL layouts, not register counts or Metal ABI sizes. WGSL gives
`bool` the same 4-byte size/alignment as `u32`; the reflection test substitutes
that type in declarations only because the current reflection dependency reports
zero-sized non-host-shareable booleans. See the
[WGSL layout rules](https://gpuweb.github.io/gpuweb/wgsl/#alignment-and-size).

## Compiler sensitivity and measured headroom

On Apple M4 Max / Chrome Metal, one leading boolean added to either resolved
materials or prepared BSDFs can make the no-graph kernel several times slower.
The effect remains with an unused field and with independently consumed runtime
values. Appending an unused boolean does not reproduce that cliff in the same
profiles. Leading numeric fields, including up to sixteen members, do not show
the same catastrophic transition, although live guards and larger values add
work. There is no supported universal margin measured in spare scalars: type,
position and compiler variant matter. A leading boolean has no demonstrated
safe margin on this configuration. Preserve existing flag words rather than
assuming an extra boolean is cheap.

Dawn's `dump_shaders` and `disable_symbol_renaming` toggles expose the generated
MSL. The slow boolean and fast numeric variants can have identical Metal ABI
sizes/alignment, so aggregate byte size alone does not explain the difference.
Spilling and occupancy remain unconfirmed. `maxTotalThreadsPerThreadgroup` is
not a pressure metric here: Dawn writes `max_total_threads_per_threadgroup(64)`
into the MSL. Recompiling without that annotation reports 1024 for both fast and
slow variants, but also changes the compilation conditions.

The evidence supports guarding compiler inputs and measuring real pipelines.
It does not establish a benefit for splitting kernels or adopting wavefront
execution. Other GPUs, drivers and compiler versions remain unmeasured; keep
platform-specific pipeline dumps and experiment data outside the repository.
