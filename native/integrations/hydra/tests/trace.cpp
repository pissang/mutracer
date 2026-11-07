// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "bridge.h"
#include "pxr/base/gf/camera.h"
#include "pxr/base/tf/errorMark.h"
#include "pxr/base/trace/collector.h"
#include "pxr/base/trace/reporter.h"
#include "pxr/imaging/hgi/blitCmds.h"
#include "pxr/imaging/hgi/blitCmdsOps.h"
#include "pxr/imaging/hgi/hgi.h"
#include "pxr/usd/usd/stage.h"
#include "pxr/usd/usdGeom/imageable.h"
#include "pxr/usd/usdGeom/mesh.h"
#include "pxr/usd/usdGeom/xformCommonAPI.h"
#include "pxr/usd/usdShade/material.h"
#include "pxr/usd/usdShade/materialBindingAPI.h"
#include "pxr/usd/usdShade/shader.h"
#include "pxr/usdImaging/usdImagingGL/engine.h"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <unistd.h>
PXR_NAMESPACE_USING_DIRECTIVE
using namespace mtHydra;
void DelayHostConsumers(Hgi *);
int main(int argc, char **argv) {
  if (argc < 3) {
    std::cerr << "hydraTrace scene.usda output-prefix [renderer] [width] "
                 "[height] [samples] [edits]\n";
    return 2;
  }
  auto rootLayer = SdfLayer::FindOrOpen(argv[1]);
  auto sessionPath = std::getenv("MUTRACER_HYDRA_SESSION");
  auto stage =
      sessionPath ? UsdStage::Open(rootLayer, SdfLayer::FindOrOpen(sessionPath))
                  : UsdStage::Open(rootLayer);
  if (!stage)
    return 2;
  std::string prefix = argv[2],
              renderer = argc > 3 ? argv[3] : "HdMuTracerRendererPlugin";
  int width = argc > 4 ? std::stoi(argv[4]) : 256,
      height = argc > 5 ? std::stoi(argv[5]) : 256,
      samples = argc > 6 ? std::stoi(argv[6]) : 16;
  TfErrorMark errors;
  bool timing = std::getenv("MUTRACER_HYDRA_TIMELINE") != nullptr;
  if (timing)
    TraceCollector::GetInstance().SetEnabled(true);
  UsdImagingGLEngine::Parameters ep;
  ep.rendererPluginId = TfToken(renderer);
  UsdImagingGLEngine engine(ep);
  if (auto cpu = std::getenv("MUTRACER_HYDRA_CPU"))
    engine.SetRendererSetting(TfToken("forceCpuOutput"),
                              VtValue(std::stoi(cpu)));
  if (auto backend = std::getenv("MUTRACER_HYDRA_BACKEND"))
    engine.SetRendererSetting(TfToken("backend"), VtValue(std::stoi(backend)));
  engine.SetRendererSetting(
      TfToken("convergedSamplesPerPixel"),
      VtValue(std::getenv("MUTRACER_HYDRA_BENCH") ? 4 : samples));
  if (auto fps = std::getenv("MUTRACER_HYDRA_FPS"))
    engine.SetRendererSetting(TfToken("displayRefreshRate"),
                              VtValue(std::stoi(fps)));
  if (auto scale = std::getenv("MUTRACER_HYDRA_SCALE"))
    engine.SetRendererSetting(TfToken("resolutionScale"),
                              VtValue(std::stof(scale)));
  engine.SetRendererSetting(HdRenderSettingsTokens->domeLightCameraVisibility,
                            VtValue(false));
  engine.SetRenderBufferSize(GfVec2i(width, height));
  engine.SetRenderViewport(GfVec4d(0, 0, width, height));
  std::vector<TfToken> aovs = {HdAovTokens->color, HdAovTokens->depth,
                               HdAovTokens->primId, HdAovTokens->instanceId,
                               HdAovTokens->elementId};
  if (std::getenv("MUTRACER_HYDRA_CENTER_AOVS") &&
      renderer != "HdStormRendererPlugin")
    aovs.insert(aovs.end(), {HdAovTokens->normal, HdAovTokens->Neye,
                             HdAovTokens->Peye});
  if (auto vector = std::getenv("MUTRACER_HYDRA_VECTOR_AOV"))
    aovs.push_back(TfToken(vector));
  if (std::getenv("MUTRACER_HYDRA_COLOR_ONLY"))
    engine.SetRendererAovs({HdAovTokens->color});
  else if (!std::getenv("MUTRACER_HYDRA_ALL_AOVS") ||
      renderer == "HdStormRendererPlugin")
    engine.SetRendererAov(HdAovTokens->color);
  else
    engine.SetRendererAovs(aovs);
  GfCamera camera;
  camera.SetTransform(GfMatrix4d(1).SetTranslate(GfVec3d(0, 0, 5)));
  camera.SetPerspectiveFromAspectRatioAndFieldOfView(float(width) / height, 45,
                                                     GfCamera::FOVVertical);
  engine.SetCameraState(camera.GetFrustum().ComputeViewMatrix(),
                        camera.GetFrustum().ComputeProjectionMatrix());
  if (stage->GetPrimAtPath(SdfPath("/Camera")))
    engine.SetCameraPath(SdfPath("/Camera"));
  UsdImagingGLRenderParams params;
  params.enableLighting = true;
  params.enableSceneMaterials = true;
  params.clearColor = GfVec4f(0);
  params.showGuides = false;
  params.showProxy = true;
  params.showRender = true;
  if (std::getenv("MUTRACER_HYDRA_CLEAR"))
    params.clearColor = GfVec4f(.2f, .3f, .4f, .5f);
  engine.SetEnablePresentation(false);
  std::ofstream frames(prefix + "-frames.jsonl");
  std::ofstream summaries(prefix + "-summary.jsonl");
  auto run = [&](std::string const &label) {
    std::vector<double> frameTimes;
    auto start = Clock::now();
    unsigned frame = 0;
    do {
      auto begin = Clock::now();
      engine.Render(stage->GetPseudoRoot(), params);
      if (std::getenv("MUTRACER_HYDRA_SLOW_HOST") && frame >= 20 &&
          frame % 20 == 0)
        DelayHostConsumers(engine.GetHgi());
      frameTimes.push_back(Milliseconds(begin));
      frames << "{\"edit\":\"" << label << "\",\"frame\":" << frame++
             << ",\"ms\":" << Milliseconds(begin)
             << ",\"converged\":" << (engine.IsConverged() ? "true" : "false")
             << "}\n";
      frames.flush();
      if (!errors.IsClean()) {
        for (auto it = errors.GetBegin(); it != errors.GetEnd(); ++it)
          std::cerr << it->GetCommentary() << "\n";
        errors.Clear();
        throw std::runtime_error("Hydra error; see stderr");
      }
      if (Milliseconds(start) > 120000)
        throw std::runtime_error("render timeout");
      if (!engine.IsConverged())
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while (!engine.IsConverged());
    double wallMs = Milliseconds(start);
    std::sort(frameTimes.begin(), frameTimes.end());
    auto percentile = [&](double p) {
      return frameTimes[size_t((frameTimes.size() - 1) * p)];
    };
    summaries << "{\"phase\":\"" << label << "\",\"frames\":" << frame
              << ",\"wallMs\":" << wallMs << ",\"p50Ms\":" << percentile(.5)
              << ",\"p95Ms\":" << percentile(.95) << ",\"samplesPerSecond\":"
              << (label == "warmup" ? 4 : samples) * 1000. / wallMs << "}\n";
    summaries.flush();
    if (auto expected = std::getenv("MUTRACER_HYDRA_EXPECT_GPU")) {
      bool gpu = std::stoi(expected) != 0 && label != "cpu";
      for (auto token : {HdAovTokens->color, HdAovTokens->depth})
        if (auto buffer = engine.GetAovRenderBuffer(token)) {
          auto resource = buffer->GetResource(false);
          bool actual = resource.IsHolding<HgiTextureHandle>() &&
                        bool(resource.UncheckedGet<HgiTextureHandle>());
          if (actual != gpu)
            throw std::runtime_error("unexpected GPU resource for " + token.GetString());
          std::cout << "RESOURCE " << label << " " << token << " GPU=" << actual << "\n";
        }
    }
    if (!std::getenv("MUTRACER_HYDRA_BENCH"))
      for (auto token : aovs) {
        auto b = engine.GetAovRenderBuffer(token);
        if (!b)
          continue;
        b->Resolve();
        if (token == HdAovTokens->color || token == HdAovTokens->depth) {
          // Read the texture returned by the actual HdxAovInputTask, separately
          // from Map(), so comparisons exercise the GPU conversion/consumer
          // path.
          auto texture = engine.GetAovTexture(token);
          if (texture) {
            // Task-list changes in OpenUSD 26.03 can leave stale task-context
            // textures. Reject them before encoding an out-of-bounds read.
            if (texture->GetDescriptor().dimensions !=
                GfVec3i(b->GetWidth(), b->GetHeight(), 1))
              throw std::runtime_error(
                  "Hdx returned a stale AOV texture after a task-list change");
            std::vector<uint8_t> pixels(size_t(b->GetWidth()) * b->GetHeight() *
                                        HdDataSizeOfFormat(b->GetFormat()));
            HgiTextureGpuToCpuOp op;
            op.gpuSourceTexture = texture;
            op.cpuDestinationBuffer = pixels.data();
            op.destinationBufferByteSize = pixels.size();
            auto commands = engine.GetHgi()->CreateBlitCmds();
            commands->CopyTextureGpuToCpu(op);
            engine.GetHgi()->SubmitCmds(commands.get(),
                                        HgiSubmitWaitTypeWaitUntilCompleted);
            std::ofstream out(prefix + "-" + label + "-" + token.GetString() +
                                  "-hgi.bin",
                              std::ios::binary);
            out.write(reinterpret_cast<char const *>(pixels.data()),
                      pixels.size());
          }
        }
        auto data = b->Map();
        if (data) {
          std::cerr << "AOV " << token << " format " << int(b->GetFormat())
                    << " size " << b->GetWidth() << "x" << b->GetHeight()
                    << "\n";
          std::ofstream out(prefix + "-" + label + "-" + token.GetString() +
                                ".bin",
                            std::ios::binary);
          out.write(static_cast<char const *>(data),
                    size_t(b->GetWidth()) * b->GetHeight() *
                        HdDataSizeOfFormat(b->GetFormat()));
        }
        b->Unmap();
      }
    std::cout << label << " " << Milliseconds(start) << " ms, " << frame
              << " frames\n";
  };
  try {
    if (std::getenv("MUTRACER_HYDRA_BENCH")) {
      run("warmup");
      engine.SetRendererSetting(TfToken("convergedSamplesPerPixel"),
                                VtValue(samples));
      UsdGeomXformCommonAPI(stage->GetPrimAtPath(SdfPath("/Camera")))
          .SetTranslate(GfVec3d(0, 0, 5.01));
      run("steady");
    } else
      run("initial");
    if (std::getenv("MUTRACER_HYDRA_COMPARE")) {
      engine.SetRendererSetting(TfToken("forceCpuOutput"), VtValue(1));
      run("cpu");
      engine.SetRendererSetting(TfToken("forceCpuOutput"), VtValue(0));
      run("gpu-repeat");
    }
    if (std::getenv("MUTRACER_HYDRA_UDIM_EDITS")) {
      auto image = UsdShadeShader(
          stage->GetPrimAtPath(SdfPath("/Materials/Open/Image")));
      // Edit copies of the tiles so the checked-in fixtures stay unchanged.
      auto fixtureDir = std::filesystem::path(argv[1]).parent_path();
      auto tileDir = std::filesystem::temp_directory_path() /
                     ("mutracer-hydra-udim-" + std::to_string(::getpid()));
      std::filesystem::create_directories(tileDir);
      for (auto tile : {"checker-update.1001.png", "checker-update.1002.png"})
        std::filesystem::copy_file(
            fixtureDir / tile, tileDir / tile,
            std::filesystem::copy_options::overwrite_existing);
      image.GetInput(TfToken("file"))
          .Set(SdfAssetPath((tileDir / "checker-update.<UDIM>.png").string()));
      run("udim-reference-changed");
      std::filesystem::copy_file(
          fixtureDir / "checker-alternate.png",
          tileDir / "checker-update.1001.png",
          std::filesystem::copy_options::overwrite_existing);
      // Force the material network to be reconsidered after the asset version
      // changes while retaining the same tile set and texture reference.
      auto surface = UsdShadeShader(
          stage->GetPrimAtPath(SdfPath("/Materials/Open/Surface")));
      surface.GetInput(TfToken("coat_weight")).Set(.26f);
      run("udim-tile-content-changed");
      image.GetInput(TfToken("file"))
          .Set(SdfAssetPath("checker.<UDIM>.png"));
      run("udim-reference-reused");
      std::filesystem::remove_all(tileDir);
    }
    if (argc > 7 && !std::getenv("MUTRACER_HYDRA_UDIM_EDITS")) {
      auto mesh = stage->GetPrimAtPath(SdfPath("/Mesh"));
      for (int i = 0; i < 4; ++i) {
        UsdGeomXformCommonAPI(mesh).SetTranslate(GfVec3d(.1 * i, 0, 0));
        run("transform" + std::to_string(i));
      }
      UsdShadeShader open(
          stage->GetPrimAtPath(SdfPath("/Materials/Open/Surface")));
      open.GetInput(TfToken("coat_weight")).Set(.5f);
      run("openpbr-coat");
      open.GetInput(TfToken("base_color")).Set(GfVec3f(.1f, .5f, .2f));
      run("openpbr-color");
      UsdShadeShader preview(
          stage->GetPrimAtPath(SdfPath("/Materials/Preview/Surface")));
      preview.GetInput(TfToken("roughness")).Set(.7f);
      run("preview-roughness");
      UsdGeomImageable(mesh).MakeInvisible();
      run("hidden");
      UsdGeomImageable(mesh).MakeVisible();
      run("visible");
      auto tex = UsdShadeShader(
          stage->GetPrimAtPath(SdfPath("/Materials/Open/Image")));
      tex.GetInput(TfToken("file")).Set(SdfAssetPath("checker-alternate.png"));
      run("texture-replaced");
      auto layer = stage->GetRootLayer();
      std::string source;
      layer->ExportToString(&source);
      stage->RemovePrim(SdfPath("/Mesh"));
      run("removed");
      layer->ImportFromString(source);
      run("added");
      stage->RemovePrim(SdfPath("/Mesh"));
      layer->ImportFromString(source);
      run("remove-readd-same-frame");
      auto appended = UsdGeomMesh::Define(stage, SdfPath("/AppendedMesh"));
      appended.CreatePointsAttr().Set(VtVec3fArray{
          GfVec3f(-.35f, -.35f, .1f), GfVec3f(.35f, -.35f, .1f),
          GfVec3f(0.f, .35f, .1f)});
      appended.CreateFaceVertexCountsAttr().Set(VtIntArray{3});
      appended.CreateFaceVertexIndicesAttr().Set(VtIntArray{0, 1, 2});
      appended.CreateSubdivisionSchemeAttr().Set(UsdGeomTokens->none);
      appended.CreateDoubleSidedAttr().Set(true);
      UsdShadeMaterialBindingAPI::Apply(appended.GetPrim())
          .Bind(UsdShadeMaterial(stage->GetPrimAtPath(SdfPath("/Materials/Open"))));
      run("new-rprim-appended");
      stage->RemovePrim(SdfPath("/AppendedMesh"));
      run("new-rprim-removed");
      stage->GetPrimAtPath(SdfPath("/Light"))
          .GetAttribute(TfToken("inputs:intensity"))
          .Set(3.f);
      run("light");
      UsdGeomXformCommonAPI(stage->GetPrimAtPath(SdfPath("/Camera")))
          .SetTranslate(GfVec3d(0, 0, 6));
      run("camera");
      stage->GetPrimAtPath(SdfPath("/Camera"))
          .GetAttribute(TfToken("fStop"))
          .Set(2.f);
      stage->GetPrimAtPath(SdfPath("/Camera"))
          .GetAttribute(TfToken("focusDistance"))
          .Set(6.f);
      run("lens");
      for (auto size :
           {GfVec2i(192, 128), GfVec2i(320, 240), GfVec2i(width, height)}) {
        engine.SetRenderBufferSize(size);
        engine.SetRenderViewport(GfVec4d(0, 0, size[0], size[1]));
        run("resize" + std::to_string(size[0]));
      }
      engine.SetRendererSetting(TfToken("resolutionScale"), VtValue(.6f));
      run("scale");
      if (!std::getenv("MUTRACER_HYDRA_SKIP_SWITCH"))
        for (int cpu : {1, 0, 1, 0}) {
          engine.SetRendererSetting(TfToken("forceCpuOutput"), VtValue(cpu));
          run("switch" + std::to_string(cpu));
        }
      if (std::getenv("MUTRACER_HYDRA_AOV_SWITCH")) {
        engine.SetRendererAovs({HdAovTokens->color, HdAovTokens->depth});
        run("aov-color-depth");
        engine.SetRendererAov(HdAovTokens->color);
        run("aov-viewport");
      }
      for (int backend : {0, 1}) {
        engine.SetRendererSetting(TfToken("backend"), VtValue(backend));
        run("backend" + std::to_string(backend));
      }
      engine.SetRendererSetting(TfToken("convergedSamplesPerPixel"),
                                VtValue(16384));
      for (unsigned i = 0; i < 20; ++i)
        engine.Render(stage->GetPseudoRoot(), params);
      engine.StopRenderer();
      if (std::getenv("MUTRACER_HYDRA_CANCEL_EXIT"))
        return 0;
      engine.RestartRenderer();
      engine.SetRendererSetting(TfToken("convergedSamplesPerPixel"),
                                VtValue(samples));
      run("restart");
    }
  } catch (std::exception const &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
  if (timing) {
    TraceCollector::GetInstance().SetEnabled(false);
    std::ofstream timeline(prefix + "-timeline.json");
    TraceReporter::GetGlobalReporter()->ReportChromeTracing(timeline);
  }
  return 0;
}
