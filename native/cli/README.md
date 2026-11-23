# MuTracer video CLI

Render a [shot](schema/shot.md) on the native GPU and encode the result to MP4.
Start with the [CLI guide](guide.md) or the [example shots](examples/). See [video output](video-output.md) for EXR frames,
temporal filtering and captioned cuts.
Use `mutracer schema` to inspect or export the JSON Schema, and `mutracer guide`
to print the command-line guide. Author procedural scenes with
[Node](../../cli/README.md) or [Python and USD](../python/README.md).

## Build the CLI from source

[Build the native SDK](../README.md#build-from-source) and set
`MUTRACER_AOT_ARCHIVE` to the absolute path of the resulting core archive.

```sh
cargo build --release --locked --manifest-path native/cli/Cargo.toml
native/cli/target/release/mutracer validate native/cli/examples/material-sweep.json
```

On Windows the binary is `mutracer.exe`. Rendering uses the GPU driver and
bundled Standard OIDN weights. For Large, get the
[external guide and beauty weights](schema/shot.md#output-and-animation).
macOS and Windows use their system encoders. On Linux, install ffmpeg with
H.264 encoding to produce MP4 or use the PNG sequence.

## Install a local package

Install a platform wheel with `python -m pip install PATH.whl` to get the
`mutracer` executable and Python API. Install both the Node wrapper tarball
and its matching platform tarball with npm to use `mutracer-js`. The
standalone archive contains the executable and sample shots. Use the archive
that matches your system.

For editors with agent skills, use [the MuTracer video skill](skills/mutracer-video/SKILL.md)
to follow the validate, still, preview and render workflow.
