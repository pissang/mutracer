// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "gpu.h"
#include "pxr/imaging/hgi/computeCmds.h"
#include "pxr/imaging/hgi/graphicsCmds.h"
#include "pxr/imaging/hgi/shaderFunction.h"
#include <cstring>
#include <thread>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
static char const *conversionSource =
#include "convert.glsl.inc"
    ;
GpuOutput::GpuOutput(Hgi *h, mt_engine e)
    : hgi(h), engine(e), native(CreateInterop(h, e)) {}
GpuOutput::~GpuOutput() {
  try {
    Reset();
  } catch (std::exception const &e) {
    Warn(e.what());
  }
}
void GpuOutput::Drain() {
  char error[2048] = {};
  auto begin = Clock::now();
  uint32_t complete = 0;
  // Every accepted export has an independently submitted host consumer. No
  // readiness signal is withheld here. Check SDK loss before waiting on Hgi.
  while (!complete) {
    Check(mt_engine_gpu_poll(engine, 0, &complete, error, sizeof error), error);
    if (Milliseconds(begin) > 30000)
      throw std::runtime_error("GPU export drain timed out");
    if (!complete)
      std::this_thread::sleep_for(std::chrono::microseconds(100));
  }
  native->Drain();
}
void GpuOutput::Reset() {
  Drain();
  if (auto o = output.lock())
    o->Clear();
  if (depthPipeline)
    hgi->DestroyGraphicsPipeline(&depthPipeline);
  if (depthProgram)
    hgi->DestroyShaderProgram(&depthProgram);
  if (depthVertex)
    hgi->DestroyShaderFunction(&depthVertex);
  if (depthFragment)
    hgi->DestroyShaderFunction(&depthFragment);
  for (auto &s : slots) {
    if (s.hdrImport)
      mt_gpu_image_destroy(s.hdrImport, nullptr, 0);
    if (s.depthImport)
      mt_gpu_image_destroy(s.depthImport, nullptr, 0);
    if (s.bindings)
      hgi->DestroyResourceBindings(&s.bindings);
    if (s.depthBindings)
      hgi->DestroyResourceBindings(&s.depthBindings);
    for (auto t : {&s.hdr, &s.distance, &s.color, &s.depth, &s.clip})
      if (*t)
        hgi->DestroyTexture(t);
    s = {};
  }
  if (pipeline)
    hgi->DestroyComputePipeline(&pipeline);
  if (program)
    hgi->DestroyShaderProgram(&program);
  if (function)
    hgi->DestroyShaderFunction(&function);
  if (sampler)
    hgi->DestroySampler(&sampler);
  current = -1;
  rw = rh = width = height = 0;
}
void GpuOutput::Configure(uint32_t rwidth, uint32_t rheight, uint32_t w,
                          uint32_t h, HdFormat f) {
  Reset();
  rw = rwidth;
  rh = rheight;
  width = w;
  height = h;
  format = f;
  auto colorFormat =
      f == HdFormatFloat16Vec4 ? HgiFormatFloat16Vec4 : HgiFormatFloat32Vec4;
  HgiShaderFunctionDesc desc;
  desc.debugName = "MuTracer AOV conversion";
  desc.shaderStage = HgiShaderStageCompute;
  desc.shaderCode = conversionSource;
  desc.computeDescriptor.localSize = GfVec3i(8, 8, 1);
  HgiShaderFunctionAddStageInput(&desc, "hd_GlobalInvocationID", "uvec3",
                                 "hdGlobalInvocationID");
  HgiShaderFunctionAddTexture(&desc, "hdr", 0);
  HgiShaderFunctionAddTexture(&desc, "distance", 1);
  HgiShaderFunctionAddWritableTexture(&desc, "color", 2, 2, colorFormat);
  HgiShaderFunctionAddWritableTexture(&desc, "depth", 3, 2, HgiFormatFloat32);
  for (auto const &p : {std::pair{"dimensions", "uvec4"},
                        {"scaleValue", "vec4"},
                        {"clearValue", "vec4"},
                        {"projectionZ", "uvec4"},
                        {"projectionW", "uvec4"}})
    HgiShaderFunctionAddConstantParam(&desc, p.first, p.second);
  function = hgi->CreateShaderFunction(desc);
  if (!function || !function->IsValid())
    throw std::runtime_error(function ? function->GetCompileErrors()
                                      : "Hgi shader allocation failed");
  HgiShaderProgramDesc pd;
  pd.debugName = desc.debugName;
  pd.shaderFunctions = {function};
  program = hgi->CreateShaderProgram(pd);
  if (!program || !program->IsValid())
    throw std::runtime_error(program ? program->GetCompileErrors()
                                     : "Hgi program allocation failed");
  HgiComputePipelineDesc cd;
  cd.debugName = desc.debugName;
  cd.shaderProgram = program;
  cd.shaderConstantsDesc.byteSize = 80;
  pipeline = hgi->CreateComputePipeline(cd);
  if (!pipeline)
    throw std::runtime_error("Hgi compute pipeline allocation failed");
  sampler = hgi->CreateSampler(HgiSamplerDesc());
  HgiShaderFunctionDesc vertex;
  vertex.shaderStage = HgiShaderStageVertex;
  HgiShaderFunctionAddStageInput(&vertex, "vertexId", "uint", "hdVertexID");
  HgiShaderFunctionAddStageOutput(&vertex, "gl_Position", "vec4", "position");
  vertex.shaderCode = "void main(){vec2 "
                      "p=vec2(-1,-1);if(vertexId==1)p=vec2(3,-1);if(vertexId=="
                      "2)p=vec2(-1,3);gl_Position=vec4(p,0,1);}";
  depthVertex = hgi->CreateShaderFunction(vertex);
  HgiShaderFunctionDesc fragment;
  fragment.shaderStage = HgiShaderStageFragment;
  HgiShaderFunctionAddStageInput(&fragment, "position", "vec4", "hdFragCoord");
  HgiShaderFunctionAddStageOutput(&fragment, "gl_FragDepth", "float",
                                  "depth(any)");
  HgiShaderFunctionAddTexture(&fragment, "clip", 0, 2, HgiFormatFloat32);
  fragment.shaderCode =
      "void main(){gl_FragDepth=HgiTexelFetch_clip(ivec2(position.xy)).x;}";
  depthFragment = hgi->CreateShaderFunction(fragment);
  for (auto fn : {depthVertex, depthFragment})
    if (!fn || !fn->IsValid())
      throw std::runtime_error(fn ? fn->GetCompileErrors()
                                  : "Hgi depth shader allocation failed");
  HgiShaderProgramDesc depthPd;
  depthPd.shaderFunctions = {depthVertex, depthFragment};
  depthProgram = hgi->CreateShaderProgram(depthPd);
  if (!depthProgram || !depthProgram->IsValid())
    throw std::runtime_error("Hgi depth program failed");
  HgiGraphicsPipelineDesc depthDesc;
  depthDesc.shaderProgram = depthProgram;
  depthDesc.depthState.depthTestEnabled = true;
  depthDesc.depthState.depthWriteEnabled = true;
  depthDesc.depthState.depthCompareFn = HgiCompareFunctionAlways;
  depthDesc.depthState.stencilTestEnabled = false;
  depthDesc.depthAttachmentDesc.format = HgiFormatFloat32;
  depthDesc.depthAttachmentDesc.usage = HgiTextureUsageBitsDepthTarget;
  depthDesc.depthAttachmentDesc.loadOp = HgiAttachmentLoadOpDontCare;
  depthDesc.depthAttachmentDesc.storeOp = HgiAttachmentStoreOpStore;
  depthPipeline = hgi->CreateGraphicsPipeline(depthDesc);
  if (!depthPipeline)
    throw std::runtime_error("Hgi depth pipeline allocation failed");
  auto texture = [&](char const *label, uint32_t tw, uint32_t th, HgiFormat tf,
                     HgiTextureUsage usage = HgiTextureUsageBitsShaderRead |
                                             HgiTextureUsageBitsShaderWrite) {
    HgiTextureDesc td;
    td.debugName = label;
    td.dimensions = GfVec3i(tw, th, 1);
    td.format = tf;
    td.usage = usage;
    auto t = hgi->CreateTexture(td);
    if (!t)
      throw std::runtime_error("Hgi texture allocation failed");
    return t;
  };
  for (auto &s : slots) {
    s.hdr = texture("MuTracer HDR", rw, rh, HgiFormatFloat32Vec4);
    s.distance =
        texture("MuTracer distance/coverage", rw, rh, HgiFormatFloat32Vec4);
    s.color =
        texture("MuTracer color", w, h, colorFormat,
                HgiTextureUsageBitsShaderRead | HgiTextureUsageBitsShaderWrite |
                    HgiTextureUsageBitsColorTarget);
    s.clip = texture("MuTracer clip depth", w, h, HgiFormatFloat32);
    s.depth =
        texture("MuTracer depth attachment", w, h, HgiFormatFloat32,
                HgiTextureUsageBitsShaderRead | HgiTextureUsageBitsDepthTarget);
    s.hdrImport = native->Import(s.hdr);
    s.depthImport = native->Import(s.distance);
    HgiResourceBindingsDesc bindings;
    unsigned index = 0;
    for (auto t : {s.hdr, s.distance, s.color, s.clip}) {
      HgiTextureBindDesc binding;
      binding.bindingIndex = index;
      binding.textures = {t};
      binding.stageUsage = HgiShaderStageCompute;
      binding.writable = index >= 2;
      // HgiMetal 26.03 dereferences a sampler even for storage images.
      binding.samplers = {sampler};
      binding.resourceType = index >= 2
                                 ? HgiBindResourceTypeStorageImage
                                 : HgiBindResourceTypeCombinedSamplerImage;
      bindings.textures.push_back(binding);
      ++index;
    }
    s.bindings = hgi->CreateResourceBindings(bindings);
    HgiResourceBindingsDesc depthRb;
    HgiTextureBindDesc clipBinding;
    clipBinding.textures = {s.clip};
    clipBinding.samplers = {sampler};
    clipBinding.stageUsage = HgiShaderStageFragment;
    clipBinding.resourceType = HgiBindResourceTypeCombinedSamplerImage;
    depthRb.textures = {clipBinding};
    s.depthBindings = hgi->CreateResourceBindings(depthRb);
  }
}
void GpuOutput::ResolveDepth(Slot &s) {
  // Hydra presentation and selection can bind this as a depth attachment.
  // Metal forbids shader writes to Depth32Float, so write R32F with compute,
  // then copy exact texels through a depth-only Hgi raster pass.
  HgiGraphicsCmdsDesc desc;
  desc.depthTexture = s.depth;
  desc.depthAttachmentDesc = depthPipeline->GetDescriptor().depthAttachmentDesc;
  auto commands = hgi->CreateGraphicsCmds(desc);
  commands->BindPipeline(depthPipeline);
  commands->BindResources(s.depthBindings);
  commands->SetViewport(GfVec4i(0, 0, width, height));
  commands->Draw(3, 0, 1, 0);
  hgi->SubmitCmds(commands.get());
}
void GpuOutput::Prepare(uint32_t rwidth, uint32_t rheight, uint32_t w,
                        uint32_t h, HdFormat f, GfVec4f clear,
                        std::shared_ptr<OutputResources> const &o) {
  if (rw == rwidth && rh == rheight && width == w && height == h &&
      format == f && current >= 0) {
    o->Install(slots[current].color, slots[current].depth);
    return;
  }
  Configure(rwidth, rheight, w, h, f);
  output = o;
  struct Constants {
    uint32_t dimensions[4];
    float scale[4], clear[4];
    uint32_t projection[8];
  } constants{{w, h, rw, rh},
              {1, 1, 0, 0},
              {clear[0], clear[1], clear[2], clear[3]},
              {}};
  auto commands = hgi->CreateComputeCmds(HgiComputeCmdsDesc());
  commands->BindPipeline(pipeline);
  commands->BindResources(slots[0].bindings);
  commands->SetConstantValues(pipeline, 0, sizeof constants, &constants);
  commands->Dispatch(w, h);
  hgi->SubmitCmds(commands.get());
  ResolveDepth(slots[0]);
  native->Signal(0);
  current = 0;
  o->Install(slots[0].color, slots[0].depth);
}
bool GpuOutput::Publish(mt_render render, uint32_t rwidth, uint32_t rheight,
                        uint32_t w, uint32_t h, HdFormat f, float scale,
                        GfVec4f clear, GfMatrix4d const &projection,
                        std::shared_ptr<OutputResources> const &o,
                        double &exportMs, double &convertMs) {
  if (rw != rwidth || rh != rheight || width != w || height != h || format != f)
    Configure(rwidth, rheight, w, h, f);
  output = o;
  // Execute is after all tasks of the preceding Hydra frame. Flush commands
  // before fencing that frame's readers, even on frames with no new samples.
  if (current >= 0)
    native->Retire(current);
  char error[2048] = {};
  uint32_t complete = 0;
  Check(mt_engine_gpu_poll(engine, 0, &complete, error, sizeof error), error);
  int next = -1;
  for (unsigned i = 0; i < slots.size(); ++i)
    if (int(i) != current && native->Available(i)) {
      next = i;
      break;
    }
  if (next < 0)
    return false;
  auto &s = slots[next];
  mt_gpu_export_image images[] = {
      {sizeof(mt_gpu_export_image), MT_GPU_OUTPUT_HDR, nullptr, s.hdrImport,
       MT_GPU_TOP_FIRST, 0},
      {sizeof(mt_gpu_export_image), MT_GPU_OUTPUT_DEPTH, nullptr, s.depthImport,
       MT_GPU_TOP_FIRST, 0}};
  mt_gpu_export_desc request{sizeof request,  2,
                             nullptr,         images,
                             native->Ready(), native->ReadyValue(next),
                             native->Done(),  done + 1};
  uint64_t sequence = 0;
  auto start = Clock::now();
  auto status =
      mt_render_export_gpu(render, &request, &sequence, error, sizeof error);
  exportMs = Milliseconds(start);
  if (status == MT_ERROR_BUSY || status == MT_ERROR_INVALID_STATE)
    return false;
  Check(status, error);
  ++done;
  start = Clock::now();
  native->Wait(done);
  struct Constants {
    uint32_t dimensions[4];
    float scale[4], clear[4];
    double z[2], w[2];
  } constants{{w, h, rw, rh},
              {scale, 0, 0, 0},
              {clear[0], clear[1], clear[2], clear[3]},
              {projection[2][2], projection[3][2]},
              {projection[2][3], projection[3][3]}};
  static_assert(sizeof constants == 80);
  auto commands = hgi->CreateComputeCmds(HgiComputeCmdsDesc());
  commands->BindPipeline(pipeline);
  commands->BindResources(s.bindings);
  commands->SetConstantValues(pipeline, 0, sizeof constants, &constants);
  commands->Dispatch(w, h);
  hgi->SubmitCmds(commands.get());
  ResolveDepth(s);
  native->Signal(next);
  convertMs = Milliseconds(start);
  current = next;
  o->Install(s.color, s.depth);
  return true;
}
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
