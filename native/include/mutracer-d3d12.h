#ifndef MUTRACER_D3D12_H
#define MUTRACER_D3D12_H
#include "mutracer-engine.h"
#include "mutracer-gpu.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Same-device NT-shared D3D12 imports. HANDLE values are borrowed and are
 * never closed by MuTracer. The resource/fence must be created for the raw
 * ID3D12Device behind this engine. */
typedef struct mt_d3d12_image_desc {
  uint32_t struct_size, reserved;
  const void *next;
  void *resource_handle;
  uint32_t format, width, height, reserved2;
} mt_d3d12_image_desc;
typedef struct mt_d3d12_timeline_desc {
  uint32_t struct_size, reserved;
  const void *next;
  void *fence_handle;
} mt_d3d12_timeline_desc;
typedef struct mt_d3d12_device_info {
  uint32_t struct_size, reserved;
  void *device;
  void *queue;
} mt_d3d12_device_info;
int32_t mt_engine_d3d12_info(mt_engine engine, mt_d3d12_device_info *output,
  char *error, size_t error_capacity);
int32_t mt_engine_import_d3d12_image(mt_engine engine, const mt_d3d12_image_desc *desc,
  mt_gpu_image *output, char *error, size_t error_capacity);
int32_t mt_engine_import_d3d12_timeline(mt_engine engine, const mt_d3d12_timeline_desc *desc,
  mt_gpu_timeline *output, char *error, size_t error_capacity);
#ifdef __cplusplus
}
#endif
#endif
