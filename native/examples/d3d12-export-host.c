/* Same-device D3D12 shared-resource/fence export sketch.
 * Create the NT handles with the device returned by mt_engine_d3d12_info;
 * MuTracer opens them on that exact device and never closes the host handles.
 */
#include "mutracer-d3d12.h"
#include <stdio.h>

int main(void) {
  mt_engine engine = 0; /* created by mt_engine_create */
  mt_d3d12_device_info info = { .struct_size = sizeof info };
  char error[4096] = {0};
  if (engine == 0) {
    puts("d3d12-export-host: embed after mt_engine_create; create shared texture/fences from returned device");
    return 0;
  }
  if (mt_engine_d3d12_info(engine, &info, error, sizeof error) != MT_OK) {
    fprintf(stderr, "%s\n", error); return 1;
  }
  mt_d3d12_image_desc image = { .struct_size = sizeof image, .format = 2, .width = 8, .height = 6 };
  mt_d3d12_timeline_desc ready = { .struct_size = sizeof ready };
  mt_d3d12_timeline_desc done = { .struct_size = sizeof done };
  mt_gpu_image image_handle = 0; mt_gpu_timeline ready_handle = 0, done_handle = 0;
  if (mt_engine_import_d3d12_image(engine, &image, &image_handle, error, sizeof error) != MT_OK ||
      mt_engine_import_d3d12_timeline(engine, &ready, &ready_handle, error, sizeof error) != MT_OK ||
      mt_engine_import_d3d12_timeline(engine, &done, &done_handle, error, sizeof error) != MT_OK) {
    fprintf(stderr, "%s\n", error); return 1;
  }
  puts("d3d12-export-host: imported same-device resource/fences; submit mt_render_export_gpu after filling native handles");
  return 0;
}
