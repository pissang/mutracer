// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "bridge.h"
#include "pxr/base/gf/camera.h"
#include "pxr/base/tf/errorMark.h"
#include "pxr/base/trace/collector.h"
#include "pxr/base/trace/reporter.h"
#include "pxr/usd/usd/stage.h"
#include "pxr/usd/usdGeom/imageable.h"
#include "pxr/usd/usdGeom/mesh.h"
#include "pxr/usd/usdGeom/xformCommonAPI.h"
#include "pxr/usd/usdShade/material.h"
#include "pxr/usd/usdShade/shader.h"
#include "pxr/usdImaging/usdImagingGL/engine.h"
#include <fstream>
#include <iostream>
#include <thread>
PXR_NAMESPACE_USING_DIRECTIVE
using namespace mtHydra;
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
  if (std::getenv("MUTRACER_HYDRA_BENCH") ||
      renderer == "HdStormRendererPlugin")
    engine.SetRendererAov(HdAovTokens->color);
  else
    engine.SetRendererAovs({HdAovTokens->color, HdAovTokens->depth,
                            HdAovTokens->primId, HdAovTokens->instanceId,
                            HdAovTokens->elementId});
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
  auto run = [&](std::string const &label) {
    auto start = Clock::now();
    unsigned frame = 0;
    do {
      auto begin = Clock::now();
      engine.Render(stage->GetPseudoRoot(), params);
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
    if (!std::getenv("MUTRACER_HYDRA_BENCH"))
      for (auto token :
           {HdAovTokens->color, HdAovTokens->depth, HdAovTokens->primId,
            HdAovTokens->instanceId, HdAovTokens->elementId}) {
        auto b = engine.GetAovRenderBuffer(token);
        if (!b)
          continue;
        b->Resolve();
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
    if (argc > 7) {
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
