#ifndef MUTRACER_D3D12_H
#define MUTRACER_D3D12_H
#include "mutracer-engine.h"
#include "mutracer-gpu.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Same-device NT-shared D3D12 imports. HANDLE values are borrowed and are
 * never closed by MuTracer. The resource/fence must be created for the raw
 * ID3D12Device behind this engine. Records require struct_size == sizeof the
 * current type, next == NULL and reserved fields == 0; there is no implicit
 * default or extension chain. Calls follow the engine's ordinary exclusive
 * thread rule; only mt_render_cancel may run concurrently. */
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_D3D12_LAYOUT(type, size) static_assert(sizeof(type) == (size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_D3D12_LAYOUT(type, size) _Static_assert(sizeof(type) == (size), #type " layout")
#else
#define MT_D3D12_LAYOUT(type, size)
#endif
typedef struct mt_d3d12_image_desc {
  uint32_t struct_size, reserved;
  const void *next;
  void *resource_handle;
  uint32_t format, width, height, reserved2;
} mt_d3d12_image_desc;
MT_D3D12_LAYOUT(mt_d3d12_image_desc, 40);
typedef struct mt_d3d12_timeline_desc {
  uint32_t struct_size, reserved;
  const void *next;
  void *fence_handle;
} mt_d3d12_timeline_desc;
MT_D3D12_LAYOUT(mt_d3d12_timeline_desc, 24);
typedef struct mt_d3d12_device_info {
  uint32_t struct_size, reserved;
  void *device;
  void *queue;
} mt_d3d12_device_info;
MT_D3D12_LAYOUT(mt_d3d12_device_info, 24);
/* Returns borrowed raw ID3D12Device/ID3D12CommandQueue pointers. Do not call
 * Release and do not destroy them; they remain valid until engine destruction.
 * A NULL output or a non-DX12 engine returns INVALID_ARGUMENT/UNAVAILABLE. */
int32_t mt_engine_d3d12_info(mt_engine engine, mt_d3d12_device_info *output,
  char *error, size_t error_capacity);
/* format is a DXGI_FORMAT value. HDR accepts R32G32B32A32_FLOAT or
 * R16G16B16A16_FLOAT; depth and center-depth accept R32_FLOAT or RGBA32F;
 * display accepts R8G8B8A8_UNORM. The image must be a same-adapter,
 * single-sample, one-mip 2D shared DEFAULT-heap UAV resource with exact
 * width/height. The host remains responsible for D3D12 resource-state
 * transitions and for keeping the resource alive through the done value. The
 * resource must be in COMMON before the first accepted export; MuTracer's
 * current export leaves it in COMMON after its UAV write. Before host copy
 * readback, transition COMMON -> COPY_SOURCE and restore COPY_SOURCE -> COMMON
 * before signaling the ready fence. Do not assume ownership of the resource.
 * Invalid descriptors or a non-DX12 engine return an error without taking
 * ownership or touching external synchronization. */
int32_t mt_engine_import_d3d12_image(mt_engine engine, const mt_d3d12_image_desc *desc,
  mt_gpu_image *output, char *error, size_t error_capacity);
/* Imports a same-adapter shared ID3D12Fence. The host owns and closes the NT
 * handle only after the import handle is destroyed, all accepted exports have
 * completed, and the host has stopped using the resource. Invalid handles,
 * dimensions, format, heap, fence flags or backend return an error without
 * taking ownership. */
int32_t mt_engine_import_d3d12_timeline(mt_engine engine, const mt_d3d12_timeline_desc *desc,
  mt_gpu_timeline *output, char *error, size_t error_capacity);
#undef MT_D3D12_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
