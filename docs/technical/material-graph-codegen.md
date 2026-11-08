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
surface/shadow specialization on both shader languages. Browser adapters restore
resource identities and the original parameter value shapes after generation.

## Structure and parameters

`normalizeGraph` walks terminal inputs and node ports in canonical order,
retains only reachable nodes, assigns topological indices and removes author IDs.
Its exact key includes the implementation version, backend, texture binding
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

`MaterialGraphState` snapshots requested and installed plans. Backend caches
still own scheduling. Parameter/assignment changes covered by the installed
structure set can install without compiling. A different set waits for a short
debounce. WebGPU queues a normal async trace variant. When layout-compatible,
the old variant and its parameter records continue tracing; installation uploads
new records and binds the new variant together. WebGL stages separate program
bindings and polls KHR completion while the active bindings remain usable.
Background programs do not enter the foreground program-readiness barrier.
Adapter identity is cached before compiling programs: repeated WebGL getParameter
queries from diagnostics can flush pending driver work even after KHR polling
is separated correctly. First-use driver work can still wait at synchronous
readback; caching the identity does not make that work disappear. Texture/layout
changes can also encounter driver backpressure at ordinary uniform uploads from
the presentation pass; KHR link completion is not a guarantee that every later
GL call is nonblocking.

Only a plan matching the current request can install. Validation/compile failures
retain the successful plan and appear in the existing engine diagnostics. A
successful structural installation advances a generation observed independently
by each render target, restarting its accumulation without changing the shared
display schedule. WebGL caches background programs by exact composed source;
WebGPU uses the existing bounded variant and shader caches.

Geometry inputs use the hit's local/world transforms and primary tangent frame.
The browser specialization enables frame construction for graph materials even
without anisotropy maps. MaterialX normalmap defaults use world-space geometry;
explicit geometry nodes default to object space. Image nodes reuse the existing
texture decoding, filtering and UDIM path.

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
