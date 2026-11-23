# HDR frames, temporal filtering and cuts

Write linear OpenEXR RGBA32F frames with `--format exr`. With OIDN enabled,
these contain denoised HDR before exposure and tone mapping. A video render
also saves display PNGs and uses them for MP4 encoding. Use an `.exr` output
path for an HDR still. `mutracer-js still` also accepts `--format exr`.
Select `denoise: "none"` to compare raw samples against a browser capture.

```sh
mutracer render shot.json -o shot.mp4 --format exr --aovs
mutracer temporal shot.mp4.frames -o filtered --png-exposure -1
mutracer assemble cut.json -o final.mp4
```

Capture guides with `--aovs` to use the temporal filter. It blends matching
surfaces at the same pixel over adjacent frames, using depth, normal and
object, instance and material IDs to reject differences. It can reduce noise
on motionless surfaces. Motion lacks reprojection and may reduce the benefit
or blend across material changes. Run it on each shot before joining cuts.
To generate viewable PNGs with linear clipping and sRGB encoding, supply
`--png-exposure` in stops. The filtered EXRs stay linear.

A cut lists sequences in playback order. Paths are relative to the cut file.
`start` is a zero-based position in the sorted PNG sequence and defaults to 0.
`count` defaults to the remaining frames. All frames must have the same size.
Captions are single lines burned into the frames. Use `--font` to select a font
that covers their text.

```json
{
  "fps": 24,
  "shots": [
    {"frames": "turntable.mp4.frames", "count": 24, "caption": "Turntable"},
    {"frames": "filtered", "start": 4, "count": 24, "caption": "Material study"}
  ]
}
```
