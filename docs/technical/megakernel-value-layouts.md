# Megakernel value layouts

Changes to `OpenPbrResolvedMaterial`, `OpenPbrPreparedBsdf`, `SurfaceInteraction`,
`Path` and `MXResult` need both the CPU layout contract and the informational
GPU benchmark:

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

## Editing continuation storage

Unified editing queries retain the existing value layouts above. Their private
`MaterialQueryState` contains the original face normal, facing cosine, shading
normal and medium-event flag. With known Sobol/ZSobol constants it also stores a
48-byte scattering result and the discrete-event flag: 96 bytes, or 192 WGSL
bytes for the two-element indexed array. The prepared BSDF stays local and dies
before visibility traversal. Structured continuation dimensions are independent
of traversal's hashed samples; NEE accumulation and throughput/direction updates
still wait for visibility to return.

Sequential random queries retain the prepared BSDF instead: 768 bytes with the
tangent/coat profile, or 1536 bytes for the array. Queries without a known
sampling constant keep that form too. `PendingSceneQuery` and `CatcherQueryState`
remain 80 and 16 bytes. Known structured queries index two-element private arrays
of those records (160 and 32 WGSL bytes); random and unknown-constant queries
keep the scalar records. No second surface interaction or suspended traversal is
retained.
`editingQueries.test.ts` pins these layouts and binding compatibility. Compare
real-GPU editing and direct output with `npm run test:editing-queries` before
changing their lifetime or representation, and record timestamp benchmarks
separately for the edited scenes.
WGSL allocation sizes do not establish actual GPU registers, spills or occupancy.

The D3D12 universal graph interpreter represents its complete `MXResult` as
27 vector slots (432 WGSL bytes) rather than 27 named fields (208 bytes).
Terminal bytecode already carries the slot index, so Store writes the slot
directly; consumers retain the terminal's scalar or RGB interpretation.
Other shapes keep named fields. The logical instruction register budget stays
at 16. Five additional browser slots hold the context's UV, object position,
normal, tangent and bitangent. CPU packing redirects geometry operands to those
slots, and the shared opacity boundary refreshes its three frame values.
Shader installation repacks the private instruction copies for the installed
shape; its shader key distinguishes the slot encoding from an equal family/terminal
union in a natural shape. Cached logical programs retain their portable encoding.
This representation needs both cold compilation and GPU timestamp comparisons:
eager context loads
and indexed values can change rendering cost even when compilation improves.
Compare full-frame timestamps at matching sample indices across interleaved
variants, including arithmetic-only graphs as well as complex materials.

The unified RGB integrator also uses a two-element **function-local**
`SurfaceInteraction` array, indexed at runtime through the guard value of four.
Only slot zero is live under that contract. Its nominal 544 WGSL bytes replace a
272-byte scalar local; the 26-member surface type, resolved material, prepared
BSDF and path layouts remain unchanged. Traversal and shading receive the same
slot, rather than keeping another active surface or a traversal cursor.
`editingQueries.test.ts` compares the complete value definitions and bindings of
both generated shapes, including bevel, displacement and production formatting.
Use the editing/direct HDR and timestamp comparisons when changing this storage:
less scalar promotion and fewer PHIs need not mean a smaller DXIL binary.

With known structured sampling, the same slot selects two-element function
arrays for the resolved material and path: 800 and 192 nominal WGSL bytes with
the tangent/coat profile, versus 400 and 96 for their scalar locals. Neither
value type changes. Primary-surface instrumentation keeps scalar material/path
locals so its local names retain their meaning. The extra array elements do not
carry another material or path; compare both HDR output and GPU timestamps when
changing their addressability.

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
