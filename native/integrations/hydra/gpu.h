// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#pragma once
#include "bridge.h"
#include "mutracer-gpu.h"
#include "pxr/imaging/hgi/computePipeline.h"
#include "pxr/imaging/hgi/graphicsPipeline.h"
#include "pxr/imaging/hgi/hgi.h"
#include "pxr/imaging/hgi/shaderProgram.h"
#include <array>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
// Native adapter: Hgi has no public external timeline interface. All queue
// boundaries are serialized with Hydra Execute on the host's rendering thread.
class GpuInterop {
public:
  virtual ~GpuInterop() = default;
  virtual mt_gpu_image Import(HgiTextureHandle) = 0;
  virtual mt_gpu_timeline Done() const = 0;
  virtual mt_gpu_timeline Ready() const = 0;
  virtual bool Available(unsigned slot) const = 0;
  virtual void Retire(unsigned slot) = 0;
  virtual void Wait(uint64_t done) = 0;
  virtual void Signal(unsigned slot) = 0;
  virtual uint64_t ReadyValue(unsigned slot) const = 0;
  virtual void Drain() = 0;
};
mt_status CreateHostEngine(Hgi *, mt_engine_options const &, mt_engine *,
                           char *, size_t);
std::unique_ptr<GpuInterop> CreateInterop(Hgi *, mt_engine);
// Same rounded f64 operations as convert.glsl.inc; input is camera-forward depth.
float ClipDepth(float distance, GfMatrix4d const &projection);
class GpuOutput {
public:
  GpuOutput(Hgi *, mt_engine);
  ~GpuOutput();
  void Prepare(uint32_t, uint32_t, uint32_t, uint32_t, HdFormat, GfVec4f,
               std::shared_ptr<OutputResources> const &);
  bool Publish(mt_render, uint32_t, uint32_t, uint32_t, uint32_t, HdFormat,
               float, GfVec4f, GfMatrix4d const &, bool,
               std::shared_ptr<OutputResources> const &, double &, double &);
  void Drain();
  void Invalidate() { Reset(); }

private:
  friend struct GpuOutputTestAccess;
  struct Slot {
    HgiTextureHandle hdr, distance, color, depth, clip;
    mt_gpu_image hdrImport = 0, depthImport = 0;
    HgiResourceBindingsHandle bindings, depthBindings;
  };
  void Reset();
  void Configure(uint32_t, uint32_t, uint32_t, uint32_t, HdFormat);
  void ResolveDepth(Slot &);
  Hgi *hgi;
  mt_engine engine;
  std::unique_ptr<GpuInterop> native;
  std::array<Slot, 3> slots;
  int current = -1;
  uint64_t done = 0;
  uint32_t rw = 0, rh = 0, width = 0, height = 0;
  HdFormat format = HdFormatInvalid;
  HgiShaderFunctionHandle function;
  HgiShaderProgramHandle program;
  HgiComputePipelineHandle pipeline;
  HgiSamplerHandle sampler;
  HgiShaderFunctionHandle depthVertex, depthFragment;
  HgiShaderProgramHandle depthProgram;
  HgiGraphicsPipelineHandle depthPipeline;
  std::weak_ptr<OutputResources> output;
};
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
