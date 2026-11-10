/* Real same-device D3D12 export consumer. The host selects a DX12 adapter,
 * creates shared UAV textures/fence on MuTracer's borrowed raw device, imports
 * their NT handles, submits an export, copies both resources to readback, and
 * compares the bytes with mt_render_read_pixels before writing an output file.
 */
#define WIN32_LEAN_AND_MEAN
#include "mutracer-d3d12.h"
#include "mutracer-engine.h"
#include "mutracer-gpu.h"
#include "mutracer-scene-api.h"
#include <d3d12.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
static char error_text[4096];
#define FAIL(msg)                                                              \
  do {                                                                         \
    fprintf(stderr, "FAIL %s:%d: %s (%s)\n", __FILE__, __LINE__, (msg),        \
            error_text);                                                       \
    return 1;                                                                  \
  } while (0)
#define OK(call)                                                               \
  do {                                                                         \
    if ((call) != MT_OK)                                                       \
      FAIL(#call);                                                             \
  } while (0)
#define DX(call)                                                               \
  do {                                                                         \
    HRESULT _hr = (call);                                                      \
    if (FAILED(_hr)) {                                                         \
      fprintf(stderr, "FAIL %s:%d: %s HRESULT=0x%08lx\n", __FILE__, __LINE__,  \
              #call, (unsigned long)_hr);                                      \
      return 1;                                                                \
    }                                                                          \
  } while (0)
static int make_scene(mt_scene *out, void **encoded, size_t *encoded_size) {
  mt_scene scene = 0;
  OK(mt_scene_create(&scene, error_text, sizeof error_text));
  float bg[4] = {.18f, .31f, .52f, 1};
  mt_scene_texture_desc td;
  OK(mt_scene_texture_desc_default(&td));
  td.storage = 1;
  td.width = td.height = 1;
  td.pixels = bg;
  td.pixel_bytes = sizeof bg;
  mt_scene_texture_id tex = 0;
  OK(mt_scene_add_texture(scene, &td, &tex, error_text, sizeof error_text));
  mt_scene_environment_desc env;
  OK(mt_scene_environment_desc_default(&env));
  env.environment = tex;
  env.background = tex;
  OK(mt_scene_set_environment(scene, &env, error_text, sizeof error_text));
  float positions[] = {-1.f, -1.f, -2.f, 1.f, -1.f, -2.f, 0.f, 1.f, -2.f};
  uint32_t indices[] = {0, 1, 2};
  mt_scene_geometry_desc gd;
  OK(mt_scene_geometry_desc_default(&gd));
  gd.positions = positions;
  gd.vertex_count = 3;
  gd.indices = indices;
  gd.index_count = 3;
  mt_scene_geometry_id geometry = 0;
  OK(mt_scene_add_geometry(scene, &gd, &geometry, error_text,
                           sizeof error_text));
  mt_scene_material_desc md;
  OK(mt_scene_material_desc_default(&md));
  mt_scene_material_id material = 0;
  OK(mt_scene_add_material(scene, &md, &material, error_text,
                           sizeof error_text));
  mt_scene_mesh_desc mesh;
  OK(mt_scene_mesh_desc_default(&mesh));
  mesh.geometry = geometry;
  mesh.material = material;
  mt_scene_mesh_id mesh_id = 0;
  OK(mt_scene_add_mesh(scene, &mesh, &mesh_id, error_text, sizeof error_text));
  size_t n = 0;
  OK(mt_scene_encode(scene, NULL, 0, &n, error_text, sizeof error_text));
  void *p = malloc(n);
  if (!p)
    FAIL("scene allocation");
  OK(mt_scene_encode(scene, p, n, &n, error_text, sizeof error_text));
  *out = scene;
  *encoded = p;
  *encoded_size = n;
  return 0;
}
static int create_texture(ID3D12Device *d, uint32_t w, uint32_t h,
                          DXGI_FORMAT f, ID3D12Resource **r, HANDLE *handle) {
  D3D12_HEAP_PROPERTIES hp = {D3D12_HEAP_TYPE_DEFAULT};
  D3D12_RESOURCE_DESC rd = {D3D12_RESOURCE_DIMENSION_TEXTURE2D,
                            0,
                            w,
                            h,
                            1,
                            1,
                            f,
                            {1, 0},
                            D3D12_TEXTURE_LAYOUT_UNKNOWN,
                            D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS};
  DX(d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_SHARED, &rd,
                                D3D12_RESOURCE_STATE_COMMON, NULL,
                                IID_PPV_ARGS(r)));
  DX(d->CreateSharedHandle(*r, NULL, GENERIC_ALL, NULL, handle));
  return 0;
}
static int readback(ID3D12Device *d, ID3D12CommandQueue *q, ID3D12Resource *src,
                    uint32_t w, uint32_t h, void *out, size_t row,
                    ID3D12Fence *f, uint64_t value) {
  D3D12_RESOURCE_DESC sd = src->GetDesc();
  UINT64 total = 0;
  D3D12_PLACED_SUBRESOURCE_FOOTPRINT fp;
  UINT rows;
  UINT64 rs;
  d->GetCopyableFootprints(&sd, 0, 1, 0, &fp, &rows, &rs, &total);
  D3D12_HEAP_PROPERTIES hp = {D3D12_HEAP_TYPE_READBACK};
  D3D12_RESOURCE_DESC bd = {
      D3D12_RESOURCE_DIMENSION_BUFFER, 0, total, 1, 1, 1, DXGI_FORMAT_UNKNOWN,
      {1, 0}, D3D12_TEXTURE_LAYOUT_ROW_MAJOR, D3D12_RESOURCE_FLAG_NONE};
  ID3D12Resource *st = NULL;
  DX(d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                D3D12_RESOURCE_STATE_COPY_DEST, NULL,
                                IID_PPV_ARGS(&st)));
  ID3D12CommandAllocator *a = NULL;
  ID3D12GraphicsCommandList *l = NULL;
  DX(d->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                               IID_PPV_ARGS(&a)));
  DX(d->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, a, NULL,
                          IID_PPV_ARGS(&l)));
  D3D12_RESOURCE_BARRIER b = {D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
                              D3D12_RESOURCE_BARRIER_FLAG_NONE};
  b.Transition.pResource = src;
  b.Transition.Subresource = 0;
  b.Transition.StateBefore = D3D12_RESOURCE_STATE_COMMON;
  b.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
  l->ResourceBarrier(1, &b);
  D3D12_TEXTURE_COPY_LOCATION s = {src,
                                   D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
  s.SubresourceIndex = 0;
  D3D12_TEXTURE_COPY_LOCATION t = {st,
                                   D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
  t.PlacedFootprint = fp;
  l->CopyTextureRegion(&t, 0, 0, 0, &s, NULL);
  b.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
  b.Transition.StateAfter = D3D12_RESOURCE_STATE_COMMON;
  l->ResourceBarrier(1, &b);
  DX(l->Close());
  ID3D12CommandList *ls[] = {l};
  q->ExecuteCommandLists(1, ls);
  DX(q->Signal(f, value));
  ULONGLONG deadline = GetTickCount64() + 30000;
  for (;;) {
    UINT64 completed = f->GetCompletedValue();
    if (completed == UINT64_MAX) {
      fprintf(stderr, "D3D12 readback fence reports device removal\n");
      l->Release();
      a->Release();
      st->Release();
      return 1;
    }
    if (completed >= value)
      break;
    if (GetTickCount64() >= deadline) {
      fprintf(stderr, "D3D12 readback fence timeout\n");
      l->Release();
      a->Release();
      st->Release();
      return 1;
    }
    Sleep(1);
  }
  void *mapped = NULL;
  D3D12_RANGE rr = {0, total};
  DX(st->Map(0, &rr, &mapped));
  for (uint32_t y = 0; y < h; y++)
    memcpy((char *)out + y * row,
           (char *)mapped + fp.Offset + (size_t)y * fp.Footprint.RowPitch, row);
  D3D12_RANGE wr = {0, 0};
  st->Unmap(0, &wr);
  l->Release();
  a->Release();
  st->Release();
  (void)w;
  return 0;
}
static int depth_matches(const float *rgba, const float *r32, uint32_t pixels) {
  for (uint32_t i = 0; i < pixels; i++)
    if (memcmp(&rgba[i * 4], &r32[i], sizeof(float)) != 0)
      return 0;
  return 1;
}
int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  ID3D12Debug *debug = NULL;
  int debug_enabled = SUCCEEDED(D3D12GetDebugInterface(
      IID_ID3D12Debug, (void **)&debug));
  if (debug_enabled)
    debug->EnableDebugLayer();
  size_t n = 0;
  OK(mt_gpu_adapters(NULL, 0, &n, error_text, sizeof error_text));
  mt_gpu_adapter_info *as = (mt_gpu_adapter_info *)calloc(n, sizeof *as);
  if (!as)
    FAIL("adapter allocation");
  OK(mt_gpu_adapters(as, n, &n, error_text, sizeof error_text));
  uint32_t ai = UINT32_MAX;
  for (size_t i = 0; i < n; i++)
    if (as[i].backend == 3) {
      ai = as[i].index;
      break;
    }
  if (ai == UINT32_MAX)
    FAIL("no DX12 adapter");
  printf("D3D12 C host adapter: %s\n", as[ai].name);
  free(as);
  mt_engine_options eo;
  OK(mt_engine_options_default(&eo));
  eo.backend = MT_BACKEND_HWRT;
  mt_engine engine = 0;
  OK(mt_engine_create_on_adapter(&eo, ai, &engine, error_text,
                                 sizeof error_text));
  mt_d3d12_device_info info = {sizeof info, 0, NULL, NULL};
  OK(mt_engine_d3d12_info(engine, &info, error_text, sizeof error_text));
  ID3D12Device *d = (ID3D12Device *)info.device;
  ID3D12CommandQueue *q = (ID3D12CommandQueue *)info.queue;
#ifdef MT_PERF_720P
  const uint32_t w = 1280, h = 720, samples = 4;
#else
  const uint32_t w = 8, h = 6, samples = 1;
#endif
  ID3D12Resource *hdr = NULL, *dep = NULL, *cen = NULL;
  HANDLE hh = NULL, dh = NULL, chh = NULL;
  ID3D12Fence *done = NULL;
  HANDLE fh = NULL;
  DX(d->CreateFence(0, D3D12_FENCE_FLAG_SHARED, IID_PPV_ARGS(&done)));
  DX(d->CreateSharedHandle(done, NULL, GENERIC_ALL, NULL, &fh));
  if (create_texture(d, w, h, DXGI_FORMAT_R32G32B32A32_FLOAT, &hdr, &hh) ||
      create_texture(d, w, h, DXGI_FORMAT_R32_FLOAT, &dep, &dh) ||
      create_texture(d, w, h, DXGI_FORMAT_R32G32B32A32_FLOAT, &cen, &chh))
    FAIL("shared texture");
  mt_d3d12_image_desc
      hi = {sizeof hi, 0, NULL, hh, DXGI_FORMAT_R32G32B32A32_FLOAT, w, h, 0},
      di = {sizeof di, 0, NULL, dh, DXGI_FORMAT_R32_FLOAT, w, h, 0},
      ci = {sizeof ci, 0, NULL, chh, DXGI_FORMAT_R32G32B32A32_FLOAT, w, h, 0};
  mt_d3d12_timeline_desc ti = {sizeof ti, 0, NULL, fh};
  mt_gpu_image hih = 0, dih = 0, cih = 0;
  mt_gpu_timeline th = 0;
  OK(mt_engine_import_d3d12_image(engine, &hi, &hih, error_text,
                                  sizeof error_text));
  OK(mt_engine_import_d3d12_image(engine, &di, &dih, error_text,
                                  sizeof error_text));
  OK(mt_engine_import_d3d12_image(engine, &ci, &cih, error_text,
                                  sizeof error_text));
  OK(mt_engine_import_d3d12_timeline(engine, &ti, &th, error_text,
                                     sizeof error_text));
  mt_scene scene = 0;
  void *scene_data = NULL;
  size_t scene_n = 0;
  if (make_scene(&scene, &scene_data, &scene_n))
    return 1;
  OK(mt_engine_set_scene(engine, (const uint8_t *)scene_data, scene_n,
                         error_text, sizeof error_text));
  mt_render_options ro;
  OK(mt_render_options_default(&ro));
  ro.width = w;
  ro.height = h;
  ro.max_samples = samples;
  ro.aovs = MT_AOV_DEPTH | MT_AOV_CENTER_DEPTH;
  mt_render render = 0;
  OK(mt_render_create(engine, &ro, &render, error_text, sizeof error_text));
  OK(mt_engine_update(engine, NULL, error_text, sizeof error_text));
  mt_converge_options co;
  OK(mt_converge_options_default(samples, &co));
  ULONGLONG render_begin = GetTickCount64();
  OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
  double render_ms = (double)(GetTickCount64() - render_begin);
  size_t hb = (size_t)w * h * 16, db = (size_t)w * h * 4,
         depth_cpu_bytes = (size_t)w * h * 16, written = 0;
  float *ch = (float *)malloc(hb), *cd = (float *)malloc(depth_cpu_bytes),
        *cc = (float *)malloc(hb);
  if (!ch || !cd || !cc)
    FAIL("CPU allocation");
  ULONGLONG cpu_begin = GetTickCount64();
  OK(mt_render_read_pixels(render, MT_IMAGE_HDR, ch, hb, &written, error_text,
                           sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_DEPTH, cd, depth_cpu_bytes,
                           &written, error_text, sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_CENTER_DEPTH, cc, hb, &written,
                           error_text, sizeof error_text));
  double cpu_ms = (double)(GetTickCount64() - cpu_begin);
  mt_gpu_export_image ims[3] = {
      {sizeof ims[0], MT_GPU_OUTPUT_HDR, NULL, hih, MT_GPU_TOP_FIRST, 0},
      {sizeof ims[1], MT_GPU_OUTPUT_DEPTH, NULL, dih, MT_GPU_TOP_FIRST, 0},
      {sizeof ims[2], MT_GPU_OUTPUT_CENTER_DEPTH, NULL, cih, MT_GPU_TOP_FIRST, 0}};
  mt_gpu_export_desc ex = {sizeof ex, 3, NULL, ims, 0, 0, th, 1};
  uint64_t seq = 0;
  ULONGLONG export_begin = GetTickCount64();
  OK(mt_render_export_gpu(render, &ex, &seq, error_text, sizeof error_text));
  if (mt_engine_destroy(engine, error_text, sizeof error_text) != MT_ERROR_BUSY)
    FAIL("pending export must make engine_destroy return BUSY");
  uint32_t complete = 0;
  for (unsigned wait = 0; wait < 30000; wait++) {
    if (done->GetCompletedValue() == UINT64_MAX)
      FAIL("D3D12 fence reports device removal");
    if (done->GetCompletedValue() >= 1)
      break;
    Sleep(1);
  }
  if (done->GetCompletedValue() < 1)
    FAIL("export fence timeout");
  mt_status poll_status =
      mt_engine_gpu_poll(engine, seq, &complete, error_text, sizeof error_text);
  if (poll_status != MT_OK)
    FAIL("mt_engine_gpu_poll export");
  if (!complete)
    FAIL("export not complete");
  double export_submit_ms = (double)(GetTickCount64() - export_begin);
  float *gh = (float *)malloc(hb), *gd = (float *)malloc(db),
        *gc = (float *)malloc(hb);
  ID3D12Fence *copy = NULL;
  DX(d->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&copy)));
  printf("D3D12 export complete; beginning HDR/depth readback\n");
  if (readback(d, q, hdr, w, h, gh, hb / h, copy, 1) ||
      readback(d, q, dep, w, h, gd, db / h, copy, 2) ||
      readback(d, q, cen, w, h, gc, hb / h, copy, 3))
    FAIL("readback");
  if (memcmp(ch, gh, hb) || memcmp(cc, gc, hb) ||
      !depth_matches(cd, gd, w * h))
    FAIL("CPU/export pixel mismatch");
  ex.done_value = 2;
  uint64_t seq2 = 0;
  OK(mt_render_export_gpu(render, &ex, &seq2, error_text, sizeof error_text));
  ULONGLONG deadline = GetTickCount64() + 30000;
  for (;;) {
    UINT64 completed = done->GetCompletedValue();
    if (completed == UINT64_MAX)
      FAIL("D3D12 timeline device removal");
    if (completed >= 2)
      break;
    if (GetTickCount64() >= deadline)
      FAIL("D3D12 timeline reuse timeout");
    Sleep(1);
  }
  complete = 0;
  if (mt_engine_gpu_poll(engine, seq2, &complete, error_text,
                         sizeof error_text) != MT_OK ||
      !complete)
    FAIL("poll reused export");
  if (readback(d, q, hdr, w, h, gh, hb / h, copy, 4) ||
      readback(d, q, dep, w, h, gd, db / h, copy, 5) ||
      readback(d, q, cen, w, h, gc, hb / h, copy, 6))
    FAIL("reused readback");
  if (memcmp(ch, gh, hb) || memcmp(cc, gc, hb) ||
      !depth_matches(cd, gd, w * h))
    FAIL("reused CPU/export pixel mismatch");
#ifdef MT_PERF_720P
  const unsigned warm_frames = 5;
  ULONGLONG warm_cpu_begin = GetTickCount64();
  for (unsigned frame = 0; frame < warm_frames; frame++) {
    OK(mt_render_restart(render, error_text, sizeof error_text));
    OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_HDR, ch, hb, &written, error_text,
                             sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_DEPTH, cd, depth_cpu_bytes,
                             &written, error_text, sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_CENTER_DEPTH, cc, hb, &written,
                             error_text, sizeof error_text));
  }
  double warm_cpu_ms =
      (double)(GetTickCount64() - warm_cpu_begin) / (double)warm_frames;
  ULONGLONG warm_gpu_begin = GetTickCount64();
  for (unsigned frame = 0; frame < warm_frames; frame++) {
    OK(mt_render_restart(render, error_text, sizeof error_text));
    OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
    ex.done_value = 3 + frame;
    uint64_t warm_sequence = 0;
    OK(mt_render_export_gpu(render, &ex, &warm_sequence, error_text,
                            sizeof error_text));
    ULONGLONG warm_deadline = GetTickCount64() + 30000;
    for (;;) {
      UINT64 completed = done->GetCompletedValue();
      if (completed == UINT64_MAX)
        FAIL("D3D12 warm timeline device removal");
      if (completed >= ex.done_value)
        break;
      if (GetTickCount64() >= warm_deadline)
        FAIL("D3D12 warm timeline timeout");
      Sleep(1);
    }
    complete = 0;
    if (mt_engine_gpu_poll(engine, warm_sequence, &complete, error_text,
                           sizeof error_text) != MT_OK ||
        !complete)
      FAIL("poll warm export");
  }
  double warm_gpu_ms =
      (double)(GetTickCount64() - warm_gpu_begin) / (double)warm_frames;
  printf("D3D12 warm metrics: frames=%u samples=%u CPU frame=%.0fms "
         "(%.2f spp/s) GPU export frame=%.0fms (%.2f spp/s)\n",
         warm_frames, samples, warm_cpu_ms,
         1000.0 * samples / warm_cpu_ms, warm_gpu_ms,
         1000.0 * samples / warm_gpu_ms);
#endif
  FILE *f = fopen("d3d12-export-output.bin", "wb");
  if (!f)
    FAIL("output file");
  fwrite(gh, 1, hb, f);
  fwrite(gd, 1, db, f);
  fwrite(gc, 1, hb, f);
  fclose(f);
  printf("D3D12 metrics: samples=%u render=%.0fms (%.2f spp/s) CPU "
         "readback=%.0fms export submit+fence=%.0fms\n",
         samples, render_ms, render_ms > 0 ? 1000.0 * samples / render_ms : 0.0,
         cpu_ms, export_submit_ms);
  printf("PASS D3D12 C host: sequences=%llu,%llu HDR/depth/center-depth byte-identical "
         "twice; wrote d3d12-export-output.bin\n",
         (unsigned long long)seq, (unsigned long long)seq2);
  UINT debug_errors = 0;
  if (debug_enabled) {
    ID3D12InfoQueue *queue_info = NULL;
    if (SUCCEEDED(d->QueryInterface(IID_ID3D12InfoQueue,
                                    (void **)&queue_info))) {
      UINT64 count = queue_info->GetNumStoredMessages();
      for (UINT64 i = 0; i < count; i++) {
        SIZE_T bytes = 0;
        if (SUCCEEDED(queue_info->GetMessage(i, NULL, &bytes)) && bytes) {
          D3D12_MESSAGE *message = (D3D12_MESSAGE *)malloc(bytes);
          if (message &&
              SUCCEEDED(queue_info->GetMessage(i, message, &bytes))) {
            if (message->Severity == D3D12_MESSAGE_SEVERITY_ERROR ||
                message->Severity == D3D12_MESSAGE_SEVERITY_CORRUPTION) {
              debug_errors++;
              fprintf(stderr, "D3D12 debug ERROR id=%u: %s\n", message->ID,
                      message->pDescription ? message->pDescription : "(none)");
            }
            free(message);
          }
        }
      }
      queue_info->Release();
    }
  }
  printf("D3D12 debug layer=%s ERROR/CORRUPTION=%u\n",
         debug_enabled ? "enabled" : "unavailable", debug_errors);
  if (debug_errors)
    FAIL("D3D12 debug layer reported ERROR/CORRUPTION");
  OK(mt_render_destroy(render, error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(hih, error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(dih, error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(cih, error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(th, error_text, sizeof error_text));
  CloseHandle(hh);
  CloseHandle(dh);
  CloseHandle(chh);
  CloseHandle(fh);
  hdr->Release();
  dep->Release();
  cen->Release();
  done->Release();
  copy->Release();
  OK(mt_scene_destroy(scene, error_text, sizeof error_text));
  OK(mt_engine_destroy(engine, error_text, sizeof error_text));
  free(scene_data);
  free(ch);
  free(cd);
  free(cc);
  free(gh);
  free(gd);
  if (debug)
    debug->Release();
  return 0;
}
