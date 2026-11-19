# MuTracer video CLI

Render a [shot](schema/shot.md) on the native GPU and encode the result to MP4.
Start with the [CLI guide](guide.md) or the [example shots](examples/).
Use `mutracer schema` to inspect or export the JSON Schema, and `mutracer guide`
to print the command-line guide.

## Build the CLI from source

[Build the native SDK](../README.md#build-from-source) and set
`MUTRACER_AOT_ARCHIVE` to the absolute path of the resulting core archive.

```sh
cargo build --release --locked --manifest-path native/cli/Cargo.toml
native/cli/target/release/mutracer validate native/cli/examples/material-sweep.json
```

On Windows the binary is `mutracer.exe`. Rendering uses the GPU driver and
bundled OIDN weights. On macOS encoding uses AVFoundation. On other platforms,
install ffmpeg with H.264 encoding to produce MP4 or use the PNG sequence.
