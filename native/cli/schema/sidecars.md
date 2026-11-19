# Binary sidecars

Use a sidecar when indexed geometry or instances are too large for JSON.
A view such as `{"file":"mesh.bin","dtype":"f32","shape":[40000,3],"offset":64}`
reads positions from byte 64 of `mesh.bin`. Paths resolve relative to the
shot file. You can put several views in one file.

| Field | dtype | Shape | Contents |
| --- | --- | --- | --- |
| `positions`, `normals` | `f32` | `[N, 3]` | XYZ triples |
| `uv` | `f32` | `[N, 2]` | UV pairs |
| `indices` | `u32` | `[I]` | Three zero-based vertex indices per triangle |
| Asset `instances` | `f32` | `[N, 16]` | One column-major affine matrix per instance |

The file holds packed little-endian IEEE 754 float32 or unsigned uint32 words.
It has no header, inter-element padding or compression. The first shape
dimension counts records. `offset` defaults to 0 and must be a multiple of 4.
The file must contain at least `offset + 4 × product(shape)` bytes. Extra
bytes outside the view are allowed. Float data must be finite. Instance
matrices use affine last rows `[0, 0, 0, 1]`, with translation at indices 12–14.
For matrices alone, `{"instances":"trees.bin","count":20000}` is shorthand
for an f32 view of shape `[20000,16]` at byte 0.

Rewriting sidecar data changes the identity of the render job. Use a separate
frame directory for jobs whose shot, assets or effective render settings differ.
