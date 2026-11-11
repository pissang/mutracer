// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "gpu.h"
#include <cstdio>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
mt_status CreateHostEngine(Hgi *, mt_engine_options const &, mt_engine *,
                           char *error, size_t capacity) {
  if (error && capacity)
    std::snprintf(error, capacity, "%s", "Host Hgi GPU interop is unavailable");
  return MT_ERROR_UNAVAILABLE;
}
std::unique_ptr<GpuInterop> CreateInterop(Hgi *, mt_engine) { return {}; }
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
