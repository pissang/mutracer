# Context API

[mutracer-context.h](../include/mutracer-context.h) is the lower-level C API
under the [engine](engine.md): one context holds one committed scene, one
resolution and one accumulation. Use it for a single fixed-size image, or to
drive sampling with polling jobs. The header documents every call, state and
error.

## Render

`create → commit → render → read_pixels → destroy`:

1. `mt_context_create` (or `mt_context_create_with_backend`).
2. `mt_context_commit` a [binary descriptor](scene-format.md); `mt_scene_encode`
   produces one from a [Scene](scene.md). Width, height and quality flags come
   from the descriptor. `mt_context_commit_with_settings` changes sampling,
   bounces and seed; the defaults differ from the engine's.
3. `mt_context_render` adds samples and blocks until they finish.
4. `mt_context_read_pixels` copies linear HDR, normal or albedo pixels: bottom
   row first, raw per-sample averages.

[examples/minimal-host.c](../examples/minimal-host.c) is a complete program.

## Update

Commit the edited descriptor again. [Supported edits](scene.md#edit-a-scene)
commit incrementally; render settings and resolution changes need full
preparation. Every successful commit restarts accumulation, and a rejected
commit keeps the previous scene.

A full commit prepares on a library thread while the old scene keeps rendering,
but the committing call blocks; commit from a worker to keep a UI responsive.
Old and new resources coexist briefly. `mt_context_cancel_commit` stops it.

## Jobs

Jobs request samples without blocking:

1. `mt_context_submit` records a request; it does no GPU work.
2. Call `mt_job_poll` from any thread to submit bounded batches and observe
   completion. Polling never waits for the GPU but still spends CPU time
   preparing batches, so latency is not fixed.
3. After `mt_job_cancel`, keep polling until the in-flight batch finishes and
   the job reports cancelled or complete.

Completed samples stay accumulated, and a later job continues them. While a job
is active, blocking render, reset, readback and destroy are rejected; a commit
can prepare alongside it and drains it on publication.
[examples/job-host.c](../examples/job-host.c) shows polling from several
threads, cancellation and resuming.

On SDK-created devices and devices imported through `Engine::from_metal` /
`mt_engine_create_metal`, a Metal execution error during sampling fails the job
without crediting its
in-flight batch, including when cancellation is pending. Earlier completed
counts remain available, but the image may contain partial writes. With the
Context API, commit the scene again to restart accumulation before reading or
rendering. With the Engine API, discard the failed `Render` and create a new
one. There is no automatic retry. A host-created wgpu device shared through
`Engine::on_device` cannot provide this native execution check. A successful command buffer still does not rule out the
[known HWRT image inconsistencies](../README.md#ray-tracing-backends).

## Threads

Calls may come from any thread. Short operations serialize, and an overlapping
call can return `MT_ERROR_BUSY`; retry it. There is no fixed limit on the number
of contexts, but GPU memory is finite.
