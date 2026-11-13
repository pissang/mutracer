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

The tier is internal (`setMaterialGraphTier`) and defaults to specialized code.
The fixed register array and the operand decoding cost GPU time per evaluated
node; the interpreter variant also costs some time on hits that do not evaluate
a graph. Choosing a tier per structure is left to a budgeted planner.

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
sampled light points. `mx_emission` uses UV0/UV1, world position and the sampled
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
