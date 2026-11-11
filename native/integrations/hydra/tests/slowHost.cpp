// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "pxr/imaging/hgi/hgi.h"
#include <stdexcept>
PXR_NAMESPACE_USING_DIRECTIVE
void DelayHostConsumers(Hgi *) {
  throw std::runtime_error("Slow host queue simulation requires HgiMetal");
}
