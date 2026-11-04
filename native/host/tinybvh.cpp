// Reuse the browser adapter and official pinned TinyBVH header. No builder port.
// See native/THIRD_PARTY_NOTICES.md and native/LICENSES/TinyBVH-MIT.txt.
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
// Import directly so teardown never enters the loader to resolve a symbol.
// Keep the embedding application's DllMain available when statically linked.
extern "C" __declspec(dllimport) BOOLEAN NTAPI RtlDllShutdownInProgress();
static bool mt_native_process_terminating() {
  return RtlDllShutdownInProgress() != FALSE;
}
#endif
#define MUTRACER_TINYBVH_NATIVE
#include "../../src/tinybvh/tinybvh_wrapper.cpp"

extern "C" BuildResult* mt_native_tiny_blas(
  const float* positions, uint32_t vertexCount, const float* normals,
  const uint32_t* indices, uint32_t indexCount, float scale, const float* ranges
) noexcept {
  // Spatial splits stay disabled, matching the browser default. SIMD and
  // threading change execution, not the requested object-split algorithm.
  try { return tinybvh_build(positions, vertexCount, 3, normals, 3, indices, indexCount, scale, ranges, BVH2_LAYOUT, 0); }
  catch (...) { return nullptr; }
}

extern "C" BuildResult* mt_native_tiny_aabbs(const float* boxes, uint32_t count) noexcept {
  try {
    auto result = std::make_unique<BuildResult>();
    if (!count) return result.release();
    std::vector<tinybvh::bvhvec4> bounds(count*2);
    std::vector<uint32_t> indices(count*3), ids(count);
    for (uint32_t i=0;i<count;++i) {
      bounds[i*2]=tinybvh::bvhvec4(boxes[i*6],boxes[i*6+1],boxes[i*6+2],0);
      bounds[i*2+1]=tinybvh::bvhvec4(boxes[i*6+3],boxes[i*6+4],boxes[i*6+5],0);
      indices[i*3]=indices[i*3+1]=indices[i*3+2]=i; ids[i]=i;
    }
    tinybvh::BVH bvh; bvh.BuildAABB(bounds.data(),count);
    serializeBvh(bvh,indices,ids,nullptr,BVH2_LAYOUT,true,*result);
    return result.release();
  } catch (...) { return nullptr; }
}

// Share upstream's one process-wide pool between independent BLASes and its
// subtree jobs. Each BLAS owns a separate spawn/barrier group, including when a
// waiting worker steals another BLAS; no second all-core pool is introduced.
extern "C" void mt_native_tiny_parallel_for(uint32_t count,
  void (*fn)(uint32_t, void*), void* payload, uint32_t captureIds) noexcept {
  struct Work {void (*fn)(uint32_t, void*); void* payload; bool capture;};
  Work work{fn, payload, captureIds != 0};
  auto run = [](uint32_t i, void* data) {
    auto& work = *static_cast<Work*>(data);
    tinybvh::JobSystem::JobGroup group;
    auto* previousGroup = tinybvh::tinybvh_tl_group;
    const bool previousCapture = nativeCaptureTriangleIds;
    tinybvh::tinybvh_tl_group = &group;
    nativeCaptureTriangleIds = work.capture;
    work.fn(i, work.payload);
    tinybvh::tinybvh_builtin_barrier(nullptr);
    nativeCaptureTriangleIds = previousCapture;
    tinybvh::tinybvh_tl_group = previousGroup;
  };
  if (count == 1) run(0, &work);
  else tinybvh::tinybvh_builtin_parallel_for(count, run, &work, nullptr);
}

// Picking owns all indexed inputs: TinyBVH keeps pointers into these arrays.
// Queries only mutate their local Ray, so immutable instances can be shared.
// Picking is immutable: traversal needs nodes/indices/vertices, never the
// primitive bounds used only during construction. Rebuilding creates a new BVH.
struct PickTree : tinybvh::BVH {
  void releaseBuildScratch() {
    AlignedFree(fragment); fragment = nullptr;
  }
};
struct NativePickBvh {
  std::vector<tinybvh::bvhvec4> vertices;
  std::vector<uint32_t> indices;
  PickTree bvh;
  NativePickBvh(const float* p,uint32_t nv,const uint32_t* i,uint32_t ni)
    : vertices(nv),indices(i,i+ni) {
    for(uint32_t k=0;k<nv;k++)vertices[k]=tinybvh::bvhvec4(p[k*3],p[k*3+1],p[k*3+2],0);
    bvh.Build(vertices.data(),indices.data(),ni/3);
    bvh.releaseBuildScratch();
  }
};
extern "C" void* mt_native_pick_create(const float* p,uint32_t nv,const uint32_t* i,uint32_t ni) noexcept {
  try { return new NativePickBvh(p,nv,i,ni); } catch(...) {return nullptr;}
}
extern "C" void mt_native_pick_destroy(void* p) noexcept {delete static_cast<NativePickBvh*>(p);}
extern "C" float mt_native_pick_query(const void* p,const float* o,const float* d,float nearest) noexcept {
  tinybvh::Ray ray(tinybvh::bvhvec3(o[0],o[1],o[2]),tinybvh::bvhvec3(d[0],d[1],d[2]),nearest);
  static_cast<const NativePickBvh*>(p)->bvh.Intersect(ray);
  return ray.hit.t;
}

struct NativePickHit {float distance, u, v; uint32_t primitive;};
extern "C" uint32_t mt_native_pick_hit(const void* p,const float* o,const float* d,float nearest,NativePickHit* out) noexcept {
  tinybvh::Ray ray(tinybvh::bvhvec3(o[0],o[1],o[2]),tinybvh::bvhvec3(d[0],d[1],d[2]),nearest);
  static_cast<const NativePickBvh*>(p)->bvh.Intersect(ray);
  if (!(ray.hit.t >= 0 && ray.hit.t < nearest)) return 0;
  *out = {ray.hit.t,ray.hit.u,ray.hit.v,ray.hit.prim};
  return 1;
}
