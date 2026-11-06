// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "gpu.h"
#include "mutracer-metal.h"
#include "pxr/imaging/hgiMetal/hgi.h"
#include "pxr/imaging/hgiMetal/texture.h"
#import <Metal/Metal.h>
#include <thread>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
mt_status CreateHostEngine(Hgi *hgi, mt_engine_options const &options,
                           mt_engine *engine, char *error, size_t capacity) {
  auto metal = dynamic_cast<HgiMetal *>(hgi);
  if (!metal) {
    snprintf(error, capacity, "%s",
             hgi ? "host Hgi is not Metal" : "host has no Hgi");
    return MT_ERROR_UNAVAILABLE;
  }
  mt_metal_device_desc desc{sizeof desc, 0, nullptr,
                            (__bridge void *)metal->GetPrimaryDevice(),
                            nullptr};
  return mt_engine_create_metal(&desc, &options, engine, error, capacity);
}
class MetalInterop final : public GpuInterop {
public:
  MetalInterop(HgiMetal *h, mt_engine e) : hgi(h), sdkEngine(e) {
    ready = [hgi->GetPrimaryDevice() newSharedEvent];
    done = [hgi->GetPrimaryDevice() newSharedEvent];
    if (!ready || !done)
      throw std::runtime_error("Metal shared-event allocation failed");
    char error[2048] = {};
    mt_metal_timeline_desc desc{sizeof desc, 0, nullptr,
                                (__bridge void *)ready};
    Check(mt_engine_import_metal_timeline(e, &desc, &readyImport, error,
                                          sizeof error),
          error);
    desc.event = (__bridge void *)done;
    auto status = mt_engine_import_metal_timeline(e, &desc, &doneImport, error,
                                                  sizeof error);
    if (status != MT_OK) {
      mt_gpu_timeline_destroy(readyImport, nullptr, 0);
      Check(status, error);
    }
  }
  ~MetalInterop() override {
    mt_gpu_timeline_destroy(readyImport, nullptr, 0);
    mt_gpu_timeline_destroy(doneImport, nullptr, 0);
  }
  mt_gpu_image Import(HgiTextureHandle t) override {
    auto texture = dynamic_cast<HgiMetalTexture *>(t.Get());
    if (!texture)
      throw std::runtime_error("expected HgiMetal texture");
    mt_metal_image_desc desc{sizeof desc, 0, nullptr,
                             (__bridge void *)texture->GetTextureId()};
    mt_gpu_image image = 0;
    char error[2048] = {};
    Check(mt_engine_import_metal_image(engine(), &desc, &image, error,
                                       sizeof error),
          error);
    return image;
  }
  mt_gpu_timeline Done() const override { return doneImport; }
  mt_gpu_timeline Ready() const override { return readyImport; }
  bool Available(unsigned slot) const override {
    return ready.signaledValue >= values[slot];
  }
  uint64_t ReadyValue(unsigned slot) const override { return values[slot]; }
  void Retire(unsigned slot) override { Signal(slot); }
  void Wait(uint64_t value) override {
    // Close any prior host commands before introducing a cross-queue wait.
    hgi->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
    id<MTLCommandBuffer> commands = hgi->GetPrimaryCommandBuffer();
    [commands encodeWaitForEvent:done value:value];
    hgi->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
  }
  void Signal(unsigned slot) override {
    hgi->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
    id<MTLCommandBuffer> commands = hgi->GetPrimaryCommandBuffer();
    values[slot] = ++value;
    [commands encodeSignalEvent:ready value:value];
    hgi->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
  }
  void Drain() override {
    hgi->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
    id<MTLCommandBuffer> marker = [hgi->GetQueue() commandBuffer];
    [marker commit];
    [marker waitUntilCompleted];
    if (marker.status != MTLCommandBufferStatusCompleted)
      throw std::runtime_error("Hgi Metal consumer failed while draining");
  }

private:
  mt_engine sdkEngine = 0;
  mt_engine engine() const { return sdkEngine; }
  HgiMetal *hgi;
  id<MTLSharedEvent> ready, done;
  mt_gpu_timeline readyImport = 0, doneImport = 0;
  uint64_t value = 0;
  std::array<uint64_t, 3> values{};
};
std::unique_ptr<GpuInterop> CreateInterop(Hgi *hgi, mt_engine engine) {
  auto result =
      std::make_unique<MetalInterop>(dynamic_cast<HgiMetal *>(hgi), engine);
  return result;
}
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
