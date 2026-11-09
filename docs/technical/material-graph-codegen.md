# Shared material graph specialization

`MaterialGraph` is the browser authoring facade. Its validated canonical graph
lowers to the portable `GraphIR` before expression generation and shader
specialization. Empty structure sets return the input source unchanged. Explicit
boundary anchors fail compilation if the material evaluator changes shape.

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
The specialization passes read-only hit context by value and returns the shading
normal. `MXResult` contains only the scene's reachable terminals and the fallback
fields needed to recompute emission. Ordinary material hits skip graph evaluation.
The MaterialX frame flag shares the existing direction flag word: bit 0 selects
texture/rotation directions, bit 1 selects the MaterialX frame. Keep this value
struct's size stable; a separate graph boolean caused a substantial Metal kernel
slowdown even on hits without a graph. The allocation mechanism is driver-dependent.
MaterialX normalmap defaults use world-space geometry;
explicit geometry nodes default to object space. Image nodes reuse the existing
texture decoding, filtering and UDIM path.

The viewer lowers image networks only when existing slots can preserve their
operations. Channel copying preserves decoded image channels; scalar sRGB decoding,
nonzero output bias, nonlinear color math, and unsupported coordinate transforms
retain graphs. Missing or undecodable direct-map resources also retain the graph
and its image defaults. A texture's optional MaterialX normal frame uses the same
world-space decode as a normal terminal, selected by a half-integer normal-map
index; truncation still addresses the original texture. The ordinary cotangent
normal path remains the default. This browser slot specialization does not add
native descriptor options or change the default native shader.

## Current boundaries

This is an authored typed graph API, not a MaterialX XML/USD importer. Unknown
categories, unsupported input variants and unsupported terminal semantics fail
as whole graphs. In particular, arbitrary graph emission on lit materials needs
matching emissive-light and caustic-emitter evaluation before it can be enabled;
it currently produces a located diagnostic and forces constant fallback, even
when a formerly valid unlit graph is present. Emission graphs on unlit materials
exercise the same arithmetic/image code without entering light proposals.
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
