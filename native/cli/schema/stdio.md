# Native video stdio protocol v1

Launch `mutracer serve --stdio` with binary pipes. Requests go to stdin,
replies to stdout, and diagnostic logs to stderr. A client sends `hello` first
and waits for its reply. Send one request at a time, then read all progress
messages and its final `ok`, `frame` or `error` reply before sending another.

A header is one UTF-8 JSON object terminated by LF. It contains `type`, a client
`id` (unsigned 32-bit integer) and the fields for that message. Replies echo
the id. A payload header also carries `bytes` (unsigned 32-bit integer). The
header's LF is immediately followed by a 4-byte little-endian unsigned length
and exactly that many raw bytes. The two lengths must agree. The next header
starts immediately after the payload. For example, an asset with 5 bytes has
prefix `05 00 00 00`, then the 5 asset bytes. An absent `bytes` field means
there is no length prefix or payload. Read from one buffered stream throughout.

## Requests

| Type | Fields | Final reply |
| --- | --- | --- |
| `hello` | `protocol: 1` | `ok` with `protocol`, `shotVersion`, `descriptorVersions`, `capabilities`, `maxHeaderBytes` and `maxPayloadBytes` |
| `scene` | `format: "shot-json" \| "descriptor-v8"`, `bytes`; optional `baseDir` for shot JSON | `ok`; with `sceneHash`; replaces the current scene and clears prior edits |
| `asset` | `name`, `format: "gltf" \| "image" \| "hdr" \| "exr"`, and either `path` or `bytes` | `ok`; registers a resource for later scene input |
| `decode` | `format: "image" \| "hdr" \| "exr"`, `bytes` | `ok` with dimensions and an image payload |
| `edit` | `changes`, an array of replacements with `path` (JSON pointer) and `value`; paths identify existing animatable properties in a shot JSON scene | `ok`; validates and applies the whole batch |
| `check` | Same fields as `render` | `ok` with `denoiserWeights` hashes for external weights. Validates without GPU work |
| `render` | `frame` (zero-based), optional `t` (seconds), optional `settings` | `frame` with `frame`, `format`, `width`, `height`, `elapsedMs` and image `bytes` |

`decode` returns row-major RGBA8 for `image` and little-endian RGBA float32
for `hdr` and `exr`.

A render can emit `progress` with `frame`, `samples` and `targetSamples`
before its final reply. A `frame` payload is an encoded PNG or EXR image.
Omit `t` to use the shot's frame time. Supply explicit time and settings for
descriptor input.

`settings` accepts `size`, `spp`, `denoise`, `seed`, `seedValue`,
`sampleSequence`, `sampleSequenceOffset`, `render`, `display`, `format`
and `tracer`. The render and display objects use the
[shot output fields](shot.md#output-and-animation). A supplied object
replaces its corresponding shot setting as a group. When omitted, the
group comes from the shot or uses the v1 defaults for a descriptor.
For descriptor input, display tracks are evaluated at the supplied `t`.

Check for `render-settings`, `display-settings`, `frame-sample-sequence`,
`oidn-clean-aux-large` and `check-settings` in `hello.capabilities` before
using those features. Large additionally needs the three
[weight files](shot.md#output-and-animation). A `check` reply can be included
in the frame reuse key so a change to external weights invalidates the cache.

An embedded asset is referenced by `asset:<name>` in a shot
path. Use a server-local path for glTF with external dependencies. Paths in a
shot resolve relative to `baseDir`, defaulting to the server's working directory.

An `error` reply has `code` and `message`, with `pointer` and `hint` when
available. Codes match file mode (2 validation, 3 asset, 4 budget, 5 GPU).
Feature-dependent operations require the capability advertised by `hello`.
A rejected scene or edit preserves the current scene. Framing errors and
truncated payloads terminate the stream. Keep stdin open until the final render
reply. Closing it ends the session and stops an active render.

## Restarting a worker

Render requests use the same frame index, seed and sample sequence rules as
file mode. After a terminal GPU failure a restarted worker requires `hello`
and the assets and scene again, plus the edits needed for the next frame.
Clients that write image payloads to disk use a temporary file and rename after
a complete reply. Reuse a frame only when the scene, assets, edits, time and
effective render settings match. The scene reply hash covers shot JSON and its
files, or the descriptor payload.
