// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#pragma once
#ifdef _WIN32
#include <windows.h>
#include "pxr/imaging/garch/glApi.h"
#include <iostream>
#include <stdexcept>
// Process-local adapter preference, without changing driver or system settings.
// https://developer.download.nvidia.com/devzone/devcenter/gamegraphics/files/OptimusRenderingPolicies.pdf
extern "C" { __declspec(dllexport) DWORD NvOptimusEnablement = 1; }
// An owned, hidden Win32 drawable. GlfTestGLContext is a no-op on Windows.
class TestGLContext {
public:
  TestGLContext() {
    try {
      window = CreateWindowExW(0, L"STATIC", L"MuTracer GPU test", WS_POPUP,
                               0, 0, 1, 1, nullptr, nullptr,
                               GetModuleHandleW(nullptr), nullptr);
      if (!window || !(dc = GetDC(window)))
        throw std::runtime_error("Unable to create hidden GL drawable");
      PIXELFORMATDESCRIPTOR format{};
      format.nSize = sizeof format;
      format.nVersion = 1;
      format.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
      format.iPixelType = PFD_TYPE_RGBA;
      format.cColorBits = 32;
      format.cAlphaBits = 8;
      format.cDepthBits = 32;
      int pixelFormat = ChoosePixelFormat(dc, &format);
      if (!pixelFormat || !SetPixelFormat(dc, pixelFormat, &format) ||
          !(context = wglCreateContext(dc)) || !wglMakeCurrent(dc, context))
        throw std::runtime_error("Unable to create current WGL context");
      ::GarchGLApiLoad();
      if (!::glGetString || !::glGetString(GL_VERSION))
        throw std::runtime_error("WGL context has no GL implementation");
      std::cerr << "OpenGL " << ::glGetString(GL_VERSION) << " renderer "
                << ::glGetString(GL_RENDERER) << '\n';
    } catch (...) { Reset(); throw; }
  }
  ~TestGLContext() { Reset(); }
  void MakeCurrent() {
    if (!wglMakeCurrent(dc, context))
      throw std::runtime_error("Unable to restore test WGL context");
  }
  TestGLContext(TestGLContext const &) = delete;
  TestGLContext &operator=(TestGLContext const &) = delete;
private:
  void Reset() {
    if (context) { wglMakeCurrent(nullptr, nullptr); wglDeleteContext(context); }
    if (dc) ReleaseDC(window, dc);
    if (window) DestroyWindow(window);
    context = nullptr; dc = nullptr; window = nullptr;
  }
  HWND window = nullptr;
  HDC dc = nullptr;
  HGLRC context = nullptr;
};
#elif !defined(__APPLE__)
#include "pxr/imaging/glf/testGLContext.h"
#include <stdexcept>
class TestGLContext {
public:
  TestGLContext() {
    PXR_NS::GlfTestGLContext::RegisterGLContextCallbacks();
    context = PXR_NS::GlfTestGLContext::Create({});
    if (!context || !context->IsValid())
      throw std::runtime_error("Unable to create test OpenGL context");
    PXR_NS::GlfGLContext::MakeCurrent(context);
  }
  void MakeCurrent() { PXR_NS::GlfGLContext::MakeCurrent(context); }
private:
  PXR_NS::GlfTestGLContextSharedPtr context;
};
#else
class TestGLContext { public: void MakeCurrent() {} };
#endif
