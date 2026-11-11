// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "gpu.h"
#include "pxr/base/gf/camera.h"
#include "pxr/base/gf/frustum.h"
#include "pxr/base/gf/half.h"
#include "pxr/imaging/hgi/blitCmds.h"
#include "pxr/imaging/hgi/blitCmdsOps.h"
#include "pxr/imaging/hgi/computeCmds.h"
#include "glContext.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <random>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
struct GpuOutputTestAccess {
  static void Run(GpuOutput &gpu, HdFormat format, float scale, bool ortho, bool hasDepth) {
    constexpr unsigned w = 113, h = 71;
    auto rw = unsigned(w * scale), rh = unsigned(h * scale);
    gpu.Configure(rw, rh, w, h, format);
    auto &slot = gpu.slots[0];
    std::mt19937 random(20261106);
    std::uniform_real_distribution<float> value(-100, 100), alpha(0, 1),
        exponent(-10, 20);
    std::vector<GfVec4f> hdr(rw * rh), distance(rw * rh);
    for (size_t i = 0; i < hdr.size(); ++i) {
      hdr[i] =
          GfVec4f(value(random), value(random), value(random), alpha(random));
      if (i % 7 == 0)
        hdr[i][3] = 0;
      if (i % 11 == 0)
        hdr[i][3] = 1;
      distance[i] = GfVec4f(std::exp2(exponent(random)), 0, 0, i % 5 ? 1 : 0);
    }
    // Exercise half ties, subnormals and overflow through the same CPU oracle.
    float boundaries[] = {1.f + std::ldexp(1.f, -11),
                          1.f + std::ldexp(3.f, -11),
                          std::ldexp(1.f, -25), std::ldexp(3.f, -25),
                          std::ldexp(1.f, -24), std::ldexp(1.f, -14),
                          65504.f, 65520.f};
    for (size_t i = 0; i < sizeof boundaries / sizeof boundaries[0]; ++i)
      hdr[i] = GfVec4f(boundaries[i], -boundaries[i], boundaries[i], 1.f);
    auto upload = gpu.hgi->CreateBlitCmds();
    for (auto pair : {std::pair{slot.hdr, &hdr}, {slot.distance, &distance}}) {
      HgiTextureCpuToGpuOp op;
      op.gpuDestinationTexture = pair.first;
      op.cpuSourceBuffer = pair.second->data();
      op.bufferByteSize = pair.second->size() * 16;
      upload->CopyTextureCpuToGpu(op);
    }
    gpu.hgi->SubmitCmds(upload.get());
    GfCamera camera;
    if (ortho)
      camera.SetOrthographicFromAspectRatioAndSize(1.5, 4,
                                                   GfCamera::FOVVertical);
    else
      camera.SetPerspectiveFromAspectRatioAndFieldOfView(1.5, 45,
                                                         GfCamera::FOVVertical);
    auto projection = camera.GetFrustum().ComputeProjectionMatrix();
    GfVec4f clear(.2f, .3f, .4f, .5f);
    struct Constants {
      uint32_t dimensions[4];
      float scale[4], clear[4];
      double z[2], w[2];
    } constants{{w, h, rw, rh},
                {scale, 0, hasDepth ? 1.f : 0.f, format == HdFormatFloat16Vec4 ? 1.f : 0.f},
                {clear[0], clear[1], clear[2], clear[3]},
                {projection[2][2], projection[3][2]},
                {projection[2][3], projection[3][3]}};
    auto commands = gpu.hgi->CreateComputeCmds(HgiComputeCmdsDesc());
    commands->BindPipeline(gpu.pipeline);
    commands->BindResources(slot.bindings);
    commands->SetConstantValues(gpu.pipeline, 0, sizeof constants, &constants);
    commands->Dispatch(w, h);
    gpu.hgi->SubmitCmds(commands.get());
    gpu.ResolveDepth(slot);
    std::vector<uint8_t> color(size_t(w) * h * HdDataSizeOfFormat(format));
    std::vector<float> depth(w * h);
    auto read = gpu.hgi->CreateBlitCmds();
    HgiTextureGpuToCpuOp op;
    op.gpuSourceTexture = slot.color;
    op.cpuDestinationBuffer = color.data();
    op.destinationBufferByteSize = color.size();
    read->CopyTextureGpuToCpu(op);
    op.gpuSourceTexture = slot.depth;
    op.cpuDestinationBuffer = depth.data();
    op.destinationBufferByteSize = depth.size() * 4;
    read->CopyTextureGpuToCpu(op);
    gpu.hgi->SubmitCmds(read.get(), HgiSubmitWaitTypeWaitUntilCompleted);
    size_t errors = 0, colorErrors = 0, depthErrors = 0;
    for (unsigned y = 0; y < h; ++y)
      for (unsigned x = 0; x < w; ++x) {
        auto src =
            size_t(std::min(rh - 1, unsigned((h - 1 - y) * scale))) * rw +
            std::min(rw - 1, unsigned(x * scale));
        auto dst = size_t(y) * w + x;
        auto v = hdr[src];
        float a = std::clamp(v[3], 0.f, 1.f), expected[4];
        for (int k = 0; k < 3; ++k)
          expected[k] = std::fma(v[k], a, clear[k] * clear[3] * (1 - a));
        expected[3] = std::fma(clear[3], (1 - a), a);
        if (format == HdFormatFloat32Vec4) {
          if (std::memcmp(color.data() + dst * 16, expected, 16) != 0) {
            if (colorErrors < 3) {
              auto actual =
                  reinterpret_cast<float const *>(color.data() + dst * 16);
              std::cerr << "color " << dst << " " << expected[0] << " / "
                        << actual[0] << " alpha " << a << '\n';
            }
            colorErrors++;
            errors++;
          }
        } else {
          GfHalf half[4];
          for (int k = 0; k < 4; ++k)
            half[k] = expected[k];
          if (std::memcmp(color.data() + dst * 8, half, 8) != 0) {
            if (colorErrors < 3) {
              auto actual = reinterpret_cast<GfHalf const *>(color.data() + dst * 8);
              std::cerr << "half color " << dst << " expected " << float(half[0])
                        << ',' << float(half[1]) << ',' << float(half[2]) << ',' << float(half[3])
                        << " actual " << float(actual[0]) << ',' << float(actual[1])
                        << ',' << float(actual[2]) << ',' << float(actual[3]) << '\n';
            }
            colorErrors++;
            errors++;
          }
        }
        float z = 1;
        if (hasDepth && distance[src][3] > 0) {
          auto clip = GfVec4d(0, 0, -distance[src][0], 1) * projection;
          z = std::clamp(float((clip[2] / clip[3] + 1) * .5), 0.f, 1.f);
          float cpu = ClipDepth(distance[src][0], projection);
          if (std::memcmp(&cpu, &z, 4) != 0)
            throw std::runtime_error("CPU center depth projection differs from matrix oracle");
        }
        if (std::memcmp(&depth[dst], &z, 4) != 0) {
          if (depthErrors < 3)
            std::cerr << "depth " << dst << " " << z << " / " << depth[dst]
                      << '\n';
          depthErrors++;
          errors++;
        }
      }
    if (errors)
      throw std::runtime_error(
          "GPU conversion mismatch color=" + std::to_string(colorErrors) +
          " depth=" + std::to_string(depthErrors) + " format=" + std::to_string(format) +
          " scale=" + std::to_string(scale) + " ortho=" + std::to_string(ortho) +
          " hasDepth=" + std::to_string(hasDepth));
  }
};
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
PXR_NAMESPACE_USING_DIRECTIVE
int main() {
  try {
    TestGLContext context;
    auto hgi = Hgi::CreatePlatformDefaultHgi();
    if (!hgi) throw std::runtime_error("No supported platform Hgi");
    std::cout << "Hgi API: " << hgi->GetAPIName() << '\n';
    mt_engine engine = 0;
    mt_engine_options options;
    mt_engine_options_default(&options);
    char error[2048] = {};
    auto status = mtHydra::CreateHostEngine(hgi.get(), options, &engine, error,
                                            sizeof error);
    if (status == MT_ERROR_UNAVAILABLE)
      status = mt_engine_create(&options, &engine, error, sizeof error);
    mtHydra::Check(status, error);
    context.MakeCurrent();
    {
      mtHydra::GpuOutput gpu(hgi.get(), engine);
      for (auto f : {HdFormatFloat32Vec4, HdFormatFloat16Vec4})
        for (auto scale : {1.f, .6f})
          for (bool ortho : {false, true})
            for (bool hasDepth : {false, true})
              mtHydra::GpuOutputTestAccess::Run(gpu, f, scale, ortho, hasDepth);
    }
    mtHydra::Check(mt_engine_destroy(engine, error, sizeof error), error);
    std::cout << "GPU float32/float16 clear, scaling and double depth "
                 "conversion passed\n";
  } catch (std::exception const &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
