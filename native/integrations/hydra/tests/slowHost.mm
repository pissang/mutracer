// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "pxr/imaging/hgiMetal/hgi.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
PXR_NAMESPACE_USING_DIRECTIVE
// Hold the actual host queue for 50 ms. Readiness still comes from a GPU
// signal on an independent queue; no CPU write of signaledValue is used.
void DelayHostConsumers(Hgi *hgi) {
  auto metal = dynamic_cast<HgiMetal *>(hgi);
  if (!metal)
    return;
  id<MTLSharedEvent> event = [metal->GetPrimaryDevice() newSharedEvent];
  id<MTLCommandQueue> producer = [metal->GetPrimaryDevice() newCommandQueue];
  metal->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
  [metal->GetPrimaryCommandBuffer() encodeWaitForEvent:event value:1];
  metal->CommitPrimaryCommandBuffer(HgiMetal::CommitCommandBuffer_NoWait, true);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC),
                 dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                   id<MTLCommandBuffer> signal = [producer commandBuffer];
                   [signal encodeSignalEvent:event value:1];
                   [signal commit];
                 });
}
