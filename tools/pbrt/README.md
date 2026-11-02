# PBRT scenes

Run `npm run pbrt:inspect -- <scene.pbrt-or-url>` to list a scene's statements,
materials, textures, lights, shapes and media, plus its unique input resources
and their total download size. Includes are read; binary resources are only
queried for size. An unknown size is reported separately and is not counted as zero
in a complete size estimate. Output images named by `Film` are excluded.

Paths, including those in nested Includes, are relative to the main scene's
directory. Local input must contain every included file. URL input requires
CORS access in the viewer. Inspection does not imply that every reported feature
can be rendered.

The scene catalog uses
[mmp/pbrt-v4-scenes](https://github.com/mmp/pbrt-v4-scenes/tree/30cf4a0346ae5a80a2d7a530a3ef7d0fa4f70572).
Scenes have individual licenses listed in its README. Scene assets are downloaded
at runtime and are not included with MuTracer.
