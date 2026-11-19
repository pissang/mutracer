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
| `edit` | `changes`, an array of replacements with `path` (JSON pointer) and `value`; paths identify existing animatable properties in a shot JSON scene | `ok`; validates and applies the whole batch |
| `render` | `frame` (zero-based), optional `t` (seconds), optional `settings` (size, spp, denoise, seed, seedValue, sampleSequenceOffset, format) | `frame` with `frame`, `format`, `width`, `height`, `elapsedMs` and image `bytes` |

A render can emit `progress` with `frame`, `samples` and `targetSamples`
before its final reply. A `frame` payload is an encoded PNG or EXR image.
Omit `t` to use the shot's frame time. Supply explicit time and settings for
descriptor input. An embedded asset is referenced by `asset:<name>` in a shot
path. Use a server-local path for glTF with external dependencies. Paths in a
shot resolve relative to `baseDir`, defaulting to the server's working directory.

An `error` reply has `code` and `message`, with `pointer` and `hint` when
available. Codes match file mode (2 validation, 3 asset, 4 budget, 5 GPU).
Feature-dependent operations require the capability advertised by `hello`.
A rejected scene or edit preserves the current scene. Framing errors and
truncated payloads terminate the stream. EOF between requests ends the session.

## Restarting a worker

Render requests use the same frame index, seed and sample sequence rules as
file mode. After a terminal GPU failure a restarted worker requires `hello`
and the assets and scene again, plus the edits needed for the next frame.
Clients that write image payloads to disk use a temporary file and rename after
a complete reply. Reuse a frame only when the scene, assets, edits, time and
effective render settings match. The scene reply hash covers shot JSON and its
files, or the descriptor payload.
