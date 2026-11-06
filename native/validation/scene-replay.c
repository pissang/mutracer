/* Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
 * SDK-only replay of a v4 descriptor, including a Hydra diagnostic capture.
 * Usage: scene-replay SCENE.bin PREFIX BACKEND SAMPLES [BOUNCES]
 * Link against the SDK as for native/examples/minimal-host.c. Outputs are the
 * SDK's top-first RGBA32F HDR/depth and raw uint32 ID planes, not Hydra formats.
 */
#include "mutracer-engine.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(call) do { if ((call) != MT_OK) { fprintf(stderr, "%s: %s\n", #call, error); exit(1); } } while (0)
static char error[4096];
static uint32_t number(const char *value, uint32_t low, uint32_t high) {
  char *end;
  unsigned long n = strtoul(value, &end, 10);
  if (!*value || *end || n < low || n > high) {
    fprintf(stderr, "Invalid integer: %s\n", value);
    exit(2);
  }
  return (uint32_t)n;
}
int main(int argc, char **argv) {
  if (argc < 5 || argc > 6) {
    fprintf(stderr, "Usage: scene-replay SCENE.bin PREFIX BACKEND SAMPLES [BOUNCES]\n");
    return 2;
  }
  uint32_t backend = number(argv[3], 0, 1), samples = number(argv[4], 1, 16384);
  uint32_t bounces = argc > 5 ? number(argv[5], 1, 20) : 3;
  FILE *file = fopen(argv[1], "rb");
  if (!file || fseek(file, 0, SEEK_END)) return 2;
  long length = ftell(file);
  if (length < (long)sizeof(mt_scene_header_v4) || fseek(file, 0, SEEK_SET)) return 2;
  void *bytes = malloc((size_t)length);
  if (!bytes || fread(bytes, 1, (size_t)length, file) != (size_t)length) return 2;
  fclose(file);
  mt_scene_header_v4 header;
  memcpy(&header, bytes, sizeof header);
  mt_engine_options engine_options;
  CHECK(mt_engine_options_default(&engine_options));
  engine_options.backend = backend;
  mt_engine engine;
  CHECK(mt_engine_create(&engine_options, &engine, error, sizeof error));
  mt_render_options options;
  CHECK(mt_render_options_default(&options));
  options.width = header.width;
  options.height = header.height;
  options.max_samples = samples;
  options.bounces = bounces;
  options.bevel = (header.quality_flags & MT_QUALITY_BEVEL) != 0;
  options.dispersion_wavelengths = (header.quality_flags & MT_QUALITY_DISPERSION) ? 3 : 1;
  options.aovs = MT_AOV_DEPTH | MT_AOV_ID;
  mt_render render;
  CHECK(mt_render_create(engine, &options, &render, error, sizeof error));
  CHECK(mt_engine_set_scene(engine, bytes, (size_t)length, error, sizeof error));
  free(bytes);
  CHECK(mt_engine_update(engine, NULL, error, sizeof error));
  mt_converge_options converge;
  CHECK(mt_converge_options_default(samples, &converge));
  converge.samples_per_batch = 1;
  CHECK(mt_render_converge(render, &converge, NULL, error, sizeof error));
  const uint32_t kinds[] = {MT_IMAGE_HDR, MT_IMAGE_DEPTH, MT_IMAGE_ID};
  const char *names[] = {"hdr", "depth", "id"};
  for (unsigned i = 0; i < 3; ++i) {
    size_t written = 0;
    CHECK(mt_render_read_pixels(render, kinds[i], NULL, 0, &written, error, sizeof error));
    void *pixels = malloc(written);
    if (!pixels) return 2;
    CHECK(mt_render_read_pixels(render, kinds[i], pixels, written, &written, error, sizeof error));
    size_t path_length = strlen(argv[2]) + 32;
    char *path = malloc(path_length);
    if (!path) return 2;
    snprintf(path, path_length, "%s-%s.bin", argv[2], names[i]);
    file = fopen(path, "wb");
    if (!file || fwrite(pixels, 1, written, file) != written || fclose(file)) return 2;
    free(path);
    free(pixels);
  }
  CHECK(mt_render_destroy(render, error, sizeof error));
  CHECK(mt_engine_destroy(engine, error, sizeof error));
  return 0;
}
