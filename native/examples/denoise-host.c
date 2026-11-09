/* Optional OIDN C consumer. Inputs are linear RGBA32F files from the raw renderer.
 * Build with -I native/include and link libmutracer. No Node/JS runtime. */
#include "mutracer-denoise.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

static int read_image(const char *directory, const char *name, float *data, size_t count) {
  char path[4096];
  int size = snprintf(path, sizeof(path), "%s/%s.rgba32f", directory, name);
  if (size < 0 || (size_t)size >= sizeof(path)) return 0;
  FILE *file = fopen(path, "rb");
  if (!file) return 0;
  int ok = fread(data, sizeof(float), count, file) == count && fgetc(file) == EOF;
  fclose(file);
  return ok;
}
static unsigned dimension(const char *text) {
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(text, &end, 10);
  return errno || !*text || *end || value > 4194304 ? 0 : (unsigned)value;
}
int main(int argc, char **argv) {
  if (argc != 6 && argc != 7) {
    fprintf(stderr, "Usage: denoise-host OIDN_LIBRARY INPUT_DIR OUTPUT_FILE WIDTH HEIGHT [BACKEND]\n"
                    "BACKEND: 0=auto, 1=CPU, 2=Metal (mt_denoise_backend)\n");
    return 2;
  }
  unsigned width = dimension(argv[4]), height = dimension(argv[5]);
  unsigned backend = 0;
  if (argc == 7) {
    if (argv[6][0] < '0' || argv[6][0] > '2' || argv[6][1]) return 2;
    backend = (unsigned)(argv[6][0] - '0');
  }
  if (!width || !height || (size_t)width * height > 4194304 || backend > MT_DENOISE_METAL) return 2;
  size_t count = (size_t)width * height * 4;
  float *color = malloc(count * sizeof(float)), *normal = malloc(count * sizeof(float));
  float *albedo = malloc(count * sizeof(float)), *output = malloc(count * sizeof(float));
  mt_denoiser handle = 0;
  char error[4096] = "Invalid input images or allocation failure";
  int status = 1;
  mt_status code = MT_OK;
  if (!color || !normal || !albedo || !output ||
      !read_image(argv[2], "render", color, count) ||
      !read_image(argv[2], "normal", normal, count) ||
      !read_image(argv[2], "albedo", albedo, count)) goto done;
  code = mt_denoiser_create(argv[1], backend, &handle, error, sizeof(error));
  if (code == MT_OK)
    code = mt_denoiser_run(handle, width, height, color, normal, albedo, output, count, error, sizeof(error));
  /* MT_ERROR_UNAVAILABLE: missing OIDN library or backend; others are input or SDK errors. */
  if (code != MT_OK) goto done;
  FILE *file = fopen(argv[3], "wb");
  if (!file) { snprintf(error, sizeof(error), "Cannot open output"); goto done; }
  int complete = fwrite(output, sizeof(float), count, file) == count;
  if (fclose(file) != 0) complete = 0;
  if (!complete) { snprintf(error, sizeof(error), "Cannot write complete output"); goto done; }
  status = 0;
done:
  if (status && code != MT_OK) fprintf(stderr, "mt_status %d: %s\n", (int)code, error);
  else if (status) fprintf(stderr, "%s\n", error);
  if (handle) mt_denoiser_destroy(handle, NULL, 0);
  free(color); free(normal); free(albedo); free(output);
  return status;
}
