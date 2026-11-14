# Shared material graph specialization

`MaterialGraph` is the browser authoring facade. Its validated canonical graph
lowers to the portable `GraphIR` before expression generation and shader
specialization. `materialGraphShaderIR` returns explicit `MaterialShaderHooks`:
graph declarations, surface evaluation and an opacity capability. Empty hooks
preserve default generation byte for byte. The ray-tracing and caustic templates
own material signatures, call sites, shadow context and resolved-material layout;
no graph or MaterialX-normal pass rewrites generated WGSL. Shader compression
can strip comments and indentation without changing these insertion points.

The IR has a format version and append-only integer IDs for categories, types,
ports, outputs, geometry inputs and OpenPBR terminals. Node records contain the
category, implementation version, type and input range; input records contain the
port/type, source kind, source index and selected output. Terminal records
reference topologically ordered nodes. Parameters use four numeric components
per slot; filename parameters refer to texture slots, with -1 for no image.
Author IDs and resource objects stay at the host boundary. Validation checks
record spans, typed edges, required/defaulted ports and supported controls before
source generation.

`generateGraphIR` and `materialGraphShaderIR` are pure shared emitters; numeric
folding uses the same `evaluateNumericNode` as the browser CPU evaluator. Browser
image sampling and hit-context queries remain outside that numeric evaluator.
The required native AOT material-graph module executes these functions through
the byte ABI, checking all supported category/type combinations and complete
surface/shadow specialization. Graphs emit WGSL only: WebGL 2 does not compile
graph programs, because linking the specialized megakernel through ANGLE took
tens of seconds and stalled sampling, so graph materials there use their fallback. Browser adapters restore
resource identities and the original parameter value shapes after generation. Native and
Hydra uniform ingestion also call `foldGraphTerminal` through the serialized AOT
runtime. It validates each reachable terminal independently and delegates numeric
operations to `evaluateNumericNode`; the C++ adapter does no new node arithmetic.
Hydra ingestion schemas/default variants are generated from `nodeInputs`, and its
Standard Surface translation and glTF/PreviewSurface boundary defaults share the
viewer's source data.

## Structure and parameters

`normalizeGraph` walks terminal inputs and node ports in canonical order,
retains only reachable nodes, assigns topological indices and removes author IDs.
Its exact key includes the implementation version, texture binding
capability and typed edges/parameter slots. A short FNV fingerprint is for
reporting; caches retain the exact key. Numeric values, booleans, strings from the
supported enums, and texture identities are data. Backend pipeline keys also
include the existing transport, vertex/BVH and resource layout features.

Uniform subtrees are evaluated on the CPU into parameter slots, rounding each
folded node to Float32. Their values never appear in shader literals. Dynamic
expressions reuse previous expressions only when their typed source references
are identical; equal values in independently editable slots are not aliases.
Helper order and generated names depend on canonical indices. Separate node
outputs retain their declared scalar ports.

Browser packing uses the existing two reserved ALPHA components for topology ID
and graph-parameter record offset. Additional records use their first vec4 for
one parameter, preserving every existing material record and the native layout.
This intentionally spends one material record per parameter; measure that cost
before introducing a different browser binding layout. Source functions dispatch
by topology, so many materials using one structure emit one function. A scene's
set of functions remains one megakernel variant, rather than one pipeline per
material or per topology.

## Interpreter tier

Specialized source grows with the number of structures, and so do pipeline
compile time and megakernel cost. The WebGPU interpreter keeps one fixed WGSL
evaluator whose source depends only on the set of terminals it writes, so a
structure-set change with the same terminals reuses the installed pipeline and
uploads new programs.

`buildGraphProgram` lowers validated IR into three dependency-pruned entry
programs: surface (all terminals except opacity), opacity and emission. Nodes
map to opcode families (unary, binary, mix, remap, blend, noise, image, ...)
with a sub-operation and a fixed operand order. Uniform subtrees use the folded
parameter slots of `generateGraphIR`, so both tiers read one packed parameter
block. Operand codes select a parameter slot, a register or a geometry input,
plus a component selector and the declared width. Registers hold canonical
vec4 values: scalars are splatted and vectors zero-padded, which reproduces the
generated casts; only `convert` widening pads `w = 1`. Registers are allocated
by liveness; a structure needing more than the fixed register file, or using a
category without an opcode, stays specialized. `runGraphProgram` is the CPU
reference of the loop and is checked against `evaluateGraph` for every
supported category/type combination.

Programs follow the parameter records in `materialsBuffer`: one header record
per structure (entry instruction counts and the surface terminal mask, split
into two exact floats), then one record per instruction using the first four
rows (header, then twelve operand codes). The topology-ID component addresses
either a specialized function (positive) or a program header (negative); no
value struct changes. The surface branch applies the same per-terminal clamps
as specialized code, gated by the terminal mask. The first four operands are
decoded before the opcode switch so lanes on different opcodes share those
loads.

The fixed register array and the operand decoding cost GPU time per evaluated
node; the interpreter variant also costs some time on hits that do not evaluate
a graph.

### Compile cost and call sites

Metal inlines every call, so each call site of the evaluator compiles another
copy of the opcode switch and its helpers, and the cost does not follow source
size. Graph emission is evaluated at sampled light points inside NEE as well as
at surface hits; a second evaluator there costs about as much compile time as
the first. Three rules keep one copy on the main path:

- With the interpreter and graph emission, the browser builds a shared graph
  site. Each integrator step calls `mx_vertex` between the ray query and the
  material load. One loop with a runtime pass count runs the single
  `mx_evaluate` call for every NEE candidate's light point and then the
  surface, whose result `getMaterialPrecomputed` consumes in the same iteration.
  A light point depends only on the light table and the candidate's random
  numbers, so it is known before the vertex is shaded. The step passes the
  sampling bounce its NEE will use (`depth + 1` after a completed hit, the
  current depth otherwise), and light sampling reads the stored emission
  (`mx_nee_lookup`); the random sampling mode also reuses the site's draws.
  Estimator, candidates and structured random dimensions are unchanged.
  Fully specialized variants keep the direct path: evaluating their emissive
  structures ahead of NEE costs GPU time and saves little compile time.
- Emission and opacity programs outside the shared site run in their own loops
  (`mx_run_emission`, `mx_run_opacity`) limited to their programs' opcode
  families, and only when an interpreted structure has such a program.
- Noise helpers call `mx_perlin` from one channel loop, and the interpreter
  evaluates noise and fractal octaves through one `mx_noise_octaves` call.

The register file holds 16 values, enough for every viewer sample; it did not
change compile time measurably. Specialized code still inlines the noise
lattice at every noise node, which the compile model counts per node.

## Tier planner

`planGraphTiers` chooses a tier per structure when a structure set is requested,
so one variant can mix specialized `mx_eval_N` branches with the interpreter.
The benefit of specializing a structure is its interpreter instruction count
(surface, opacity and emission programs) times its usage, the world-space area
of the visible surfaces using it. The interpreter's extra cost is linear in
executed instructions, while the scene's traversal cost, which sets the
interpreter/baked ratio of a frame, is the same for both tiers; the planner
therefore uses no fixed interpreter ratio. Screen coverage is not used.

The cost of a structure is the compile time of its specialized source: the
generated function plus its dispatch branches, at a calibrated time per KB.
Helper libraries (noise, HSV, `rotate3d`) count once. The interpreter
compiles only the opcode families its programs use (the family set is part of
its shader key), together with the helper libraries of those families; the
planner charges it by the generated size for the families of all interpretable
structures. If every structure fits the budget, the variant omits the
interpreter, because its presence slows every hit. Otherwise the interpreter's
fixed cost is charged and the remaining budget is filled greedily by benefit per
compile millisecond. A mixed variant is built only when its specialized structures
carry at least 20 % of the estimated interpreter work; below that, extra code on
every hit outweighs the gain and all structures stay interpreted. Structures the
interpreter cannot run are always specialized, even past the budget.

Specialized source also has a size cap (120 KB by default) independent of the
compile budget: inline code slows every hit of the megakernel, about 1.07× of
baked at 110 KB and 1.15× at 220 KB on the reference grid, approaching the
interpreter at a few hundred KB.

### Compile model and budgets

Compile time is modelled per device as `s × (3.8 ms/KB of graph-free kernel +
spec × KB of specialized code + interp × KB of interpreter source beyond a free
part)`. The coefficients depend on the shader compiler, which Chrome picks by
platform:

| backend | specialized | interpreter | `s` prior |
|---|---|---|---|
| Metal (macOS) | 21 ms/KB | 48 ms/KB beyond 3.6 KB | 1 |
| D3D12 (Windows) | 450 ms/KB | 300 ms/KB beyond 3.3 KB | 1.5 |
| Vulkan, unknown | as D3D12 | as D3D12 | 2 |

The reference platform (Apple M4 Max, Chrome Metal, cold caches) has `s = 1`.
D3D12 is fitted on an RTX 4060 Laptop relative to each run's own graph-free
compile (`s ≈ 1.5`): specialized code costs ≈1.7 s per grid structure, linearly up
to 173 KB, so specialized code is only practical for one or two structures there.
Unmeasured backends assume D3D12's costs, because a pessimistic guess only keeps
the interpreter while an optimistic one starts minute-long compiles.

`s` follows cold compiles that happen anyway and contain no specialized code
(graph-free kernels and interpreter variants), in log space, so it scales
machine speed without changing the shape. A specialized compile more than 1.5×
above its prediction raises this device's specialized coefficient to match it.
Nothing is compiled only to measure. A compile under a quarter of its prediction
is a driver or browser cache hit and is ignored. Time spent while another kernel
compiled is half-subtracted as queueing, and a compile overlapped for more than
60 % of its duration is ignored. The model is kept in memory per `GPUDevice`,
never persisted.

The planner works in device milliseconds. The correct-frame budget is 1 s of
graph increment. The final-variant budget is three times this device's predicted
cold graph-free compile, clamped to 1–10 s; because both sides scale with `s`,
the specialized share of a plan depends on the backend's coefficients, the
clamps, the cap and the upgrade gate below.

### Edit-aware tiers

A new structure set is first served by a variant that renders it correctly:

- If the installed variant still covers it, nothing compiles. Covered means
  every structure is specialized there or interpretable with its opcode
  families and terminals, and the installed pipeline features (frames, UV1,
  alpha, coat, ...) include the set's. Specialized functions keep their IDs, so
  a structure removed by the edit stays as dead code until the next upgrade, and
  new or changed structures run as interpreter programs.
- Otherwise, after a first installation (a structural edit), the editing
  interpreter compiles: every opcode family, every plain terminal (those that
  change neither pipeline constants nor shared hooks) and every terminal seen in
  the session, with the union of the old and new pipeline features. Later edits
  then fit it. If its increment is predicted over the correct-frame budget, only
  the set's families are used, unless a compiled prefetched editing interpreter (below)
  covers the set.
- On the first load, a small set whose fully specialized variant fits the
  correct-frame budget compiles directly; otherwise the interpreter with only
  the set's families serves it.

Right after the first graph installation, the editing interpreter (with the
installed pipeline features) also compiles once in the background, so later
structural edits find it ready and compile nothing. It is skipped when its
compile is predicted over the 10 s upgrade ceiling below (on D3D12 it takes ≈7 s
and still compiles). An edit uses it only once it has compiled; until then, or
without it, an edit compiles as described above.

Parameter, transform and visibility edits never recompile: parameters are
material records, and tier decisions stay fixed per structure set.

### Upgrades

The planned final variant compiles only when the gate allows it:

1. The structure set has been unchanged for 2 s.
2. Its predicted compile, including the graph-free part, is at most 10 s. A WebGPU
   compile cannot be cancelled and an edit discards it; on a driver that
   serializes compiles an edit's own compile would also wait behind it.
3. No other pipeline compile is running or queued, so upgrades never pile up.
4. `(remaining − compile) × gain > 1.5 × compile`. Remaining time is the samples
   left to the render target times the measured wall time per sample; without a
   target it is the time already rendered on this view, at most 60 s. Gain is the
   expected per-sample saving: 0.2 for removing all interpreter work (P1:
   0.07–0.35 by scene) and half of that times the planner coverage for a mixed
   variant, which keeps the interpreter's presence cost.

Compiles that render an edit correctly never wait behind background work in the
pass's compile queue: they start first, and upgrades and the prefetch start only
while a compile slot stays free for an edit. A structure change while the upgrade
compiles discards its result. When the
upgrade installs, the serving variant stays cached and the two are compared on
the same view in interleaved phases (final, serving, serving, final, final,
serving), each at least 250 ms and 8 samples. GPU timestamps decide when each
variant has at least three over its phases, read back through a small pool of
buffers attributed to the variant that traced them (the readback can stall for a
whole phase behind a deep queue); wall time per sample is the fallback, but Render's realtime pacing derives it from its
own estimate and can invert small differences. The upgrade stays if it is at
least 3 % faster. Otherwise the serving variant returns, the structure set is not
upgraded again, and the device cap drops to 70 % of the rejected variant's
specialized source (at least 16 KB). The measured gain replaces the 0.2 prior for
later decisions in the scene.

An internal measurement switch (`setMaterialGraphPlanner`) can force one tier,
replace the compile model, budgets or policy constants, fix `s` or plan with
another backend's coefficients to simulate a slower compiler, salt the interpreter source and observe installations, upgrade
decisions and compile samples.

## Compilation and installation

Native raw descriptors preserve authored IDs separately from the exact structural
key. Parameters, texture references and IDs do not alter generated source. The
existing scene-preparation thread seeds fallback graphs from the installed scene,
prepares a candidate and publishes through the existing cancellation boundary.
No frame planner or second scheduler is introduced. Native material buffers use
the same parameter packing as the browser. Sparse material packets include graph
metadata so incremental edits update diagnostics without rebuilding pipelines.

The native pipeline cache admits a candidate only after its GPU error scopes
succeed. A failed graph compilation keeps the old scene and target accumulation;
a first failure prepares the authored constants through the same scene path.
An installed target can continue dispatching while a graph candidate is pending,
provided its other inputs match. Publication may retire that target between the
readiness check and dispatch; that single stale-target status retries on the next
tick. Metal uses process-local source/pipeline caches. The pre-existing optional
wgpu cache is Vulkan-only; this change adds no disk-cache format.

`MaterialGraphState` snapshots requested and installed plans. Backend caches
still own scheduling. Parameter/assignment changes covered by the installed
structure set can install without compiling. A different set waits for a short
debounce. WebGPU queues a normal async trace variant. When layout-compatible,
the old variant and its parameter records continue tracing; installation uploads
new records and binds the new variant together.

WebGPU compiles the serving and upgrade variants through the same queue; the
installed variant keeps tracing until the requested one is ready. Both tiers
evaluate the same graph (HDR block MAD 0 in P1), so a tier switch of unchanged
structures keeps accumulation; only structure or assignment changes restart it.

Only a plan matching the current request can install. Validation/compile failures
retain the successful plan and appear in the existing engine diagnostics. A
successful structural installation advances a generation observed independently
by each render target, restarting its accumulation without changing the shared
display schedule. WebGPU uses the existing bounded variant and shader caches.

Geometry inputs use the hit's local/world transforms and primary tangent frame.
The browser specialization enables frame construction only for reachable frame
inputs, normal/anisotropy terminals, or graph materials with constant anisotropy.
Lobe, transmission and UV1 capabilities likewise follow reachable terminals and
inputs; editable selectors retain all of their possible UV sets.
The material template passes read-only hit context by value and returns the
shading normal. Explicit calls cover surface integration, volume integration,
picking and AOV entry points. Native hardware traversal supplies its candidate
instance to the same opacity boundary. MaterialX normal slots use the template's
post-transform normal hook, including light-tracing and photon emitters.
`MXResult` contains only the scene's reachable terminals and the fallback fields
needed to recompute emission. Ordinary material hits skip graph evaluation.
The MaterialX frame flag shares the existing direction flag word: bit 0 selects
texture/rotation directions, bit 1 selects the MaterialX frame. Keep this value
struct's size stable; a separate graph boolean caused a substantial Metal kernel
slowdown even on hits without a graph. The allocation mechanism is driver-dependent.
MaterialX normalmap defaults use world-space geometry;
explicit geometry nodes default to object space. Image nodes reuse the existing
texture decoding, filtering and UDIM path.

The browser library lowers image networks during material preparation when
existing slots preserve their operations. The authored graph/material remain
unchanged. Slot plans support fixed UV sets, affine scale/offset, channel
selection, uniform gain and default world-space normalmap frames. Source Texture
UV transforms follow graph coordinates; color decoding remains at the sample
site. Nonzero bias, nonlinear math, scalar sRGB decoding, projected UVs,
conflicting combined maps, transmission-medium or glTF anisotropy conversion
contexts, and unavailable resources retain the graph. Additional coat, specular
and fuzz slots require bounded image channels to preserve their clamp order.

Channel variants are cached by source identity/version and swizzle; sampler
variants additionally include UV, wrap, encoding and normal-frame metadata.
Raw pixel arrays are reordered without changing their component type. DOM
images first use the atlas's Canvas color conversion, then a temporary WebGL 2
channel-copy pass shared by both backends,
without image-sized CPU readback. A one-pixel MIN-alpha reduction rejects
nonopaque sources before swizzling because Canvas alpha composition/resizing
would otherwise change channel values. Temporary GPU resources are released
at the end of each preparation batch; failed copies retain the graph until
source invalidation. Logical samplers over the same derived pixels share atlas
storage or bindless GPU images. Gains do not enter the image-cache key.

Lowered plans use internal material snapshots. Gain-only edits repack parameters;
resource/sampler changes rebuild texture metadata without graph compilation.
A transition to graph evaluation stages authored and retained slot images while
the requested shader compiles. Packing selects installed slot overrides or the
authored rows before applying graph outputs, so disconnecting a terminal restores
its authored constants/maps at installation. Slot snapshots override only connected
inputs; unconnected material edits remain live. Reachable coat, transmission and
metal slot capabilities stay enabled through zero-gain edits, avoiding a new
program when a compatible gain crosses zero. A table retains capabilities needed
by either staged result until its resources are rebuilt. Validation failures retain
the installed result. The normal frame uses
an internal half-integer normal-map index, so truncation still addresses the
original texture. No public Texture option or native descriptor is required.
The ordinary cotangent normal path remains unchanged.

## Current boundaries

This is an authored typed graph API, not a MaterialX XML/USD importer. Unknown
categories, unsupported input variants and unsupported terminal semantics fail
as whole graphs. Browser WebGPU lit emission evaluates at surface hits and
sampled light points (through the shared graph site when the variant has the
interpreter). `mx_emission` uses UV0/UV1, world position and the sampled
instance transforms, with the same fallback emission slots and single-passage
coat absorption as the surface evaluator. Graph outputs replace ordinary slot
values in both paths. Only dependencies of emission and its coat absorption are
restricted to UV/position; unrelated normal and scattering branches still have
the full surface context. Projected material UVs and shading-frame dependencies
on an emitter produce located diagnostics and force constant fallback. Unlit
emission keeps its existing evaluator and never enters the light distribution.
Emissive coat networks stay on the graph path so slot lowering cannot hide the
proposal behind an absorbed constant. Native context validation retains the
unlit-only boundary.

The installed browser plan provides a positive constant light proposal: raw
fallback emission RGB, or unit white when its luminance is at most 1e-8. CPU
triangle selection uses its luminance times world-space area, while material
packing places the identical RGB in `materialsBuffer.emission` for emissive-hit
MIS. The emitted contribution is evaluated at the sample exactly once; neither
the graph value nor a varying coat changes the proposal PDF. This proposal need
not bound the graph: positive support and matching densities keep the estimator
unbiased, though highly concentrated emission can increase variance. Black
fallback graphs are collected from all visible instance bindings. Installation,
graph edits, transport changes and membership changes refresh both the packed
proposal and the light distribution.

Browser WebGPU opts into seven-texel emissive records: the original six texels
followed by a texel whose x component is the GPU instance slot. Collection keeps
the source instance ordinal separately, remapping it after visibility/reordering
and omitting invalid transforms. The default six-texel packing and shader remain
in use by WebGL 2 and native. No resolved-material or surface-interaction value
struct grows. Light tracing and photon mapping disable the graph proposal along
with graph evaluation, preserving their constant emitter fallback.

Opacity overrides raw coverage before existing alpha-map factors and mode resolution.
The traversal helper evaluates it at the same UV/position as the surface path;
frame-dependent opacity is rejected because shadow traversal lacks the shading
frame. Browser packing conservatively marks auto graph coverage as blend, and
both pipeline capability sets retain alpha traversal. Subsurface/volume,
displacement and tangent terminals are not included.
Light-tracing and photon-mapping variants retain the constant material evaluator
and expose an unsupported-transport diagnostic until their emitter/material
evaluation is ported together; the algorithms themselves remain available.

Keep official numerical-reference files and experiment data outside the source
tree. Tests compare behavior and GPU HDR output, not snapshots of template text.
