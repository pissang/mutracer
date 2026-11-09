// Observe only queues installed in MuTracer's HAL device. Forwarding preserves
// the host queue, residency and synchronization; no process-wide swizzling.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#import <objc/message.h>

typedef void (*MuTracerRecord)(void *buffer);

// objc2 checks Objective-C method signatures in debug builds before dispatch.
// Register forwarding signatures from the public Metal protocols on our own
// classes; no Metal or host class is modified. These protocols have only scalar
// and object return values, so the normal forwarding ABI applies on macOS.
static void registerForwarders(Class cls, Protocol *protocol) {
    for (int required = 0; required <= 1; required++) {
        unsigned count = 0;
        struct objc_method_description *methods =
            protocol_copyMethodDescriptionList(protocol, required, YES, &count);
        for (unsigned i = 0; i < count; i++) {
            if (!class_getInstanceMethod(cls, methods[i].name))
                class_addMethod(cls, methods[i].name, (IMP)_objc_msgForward, methods[i].types);
        }
        free(methods);
    }
}

// Retain at commit, not creation: wgpu may create its staging buffer before
// this flight starts, or discard an unused encoder. Observe the actual native
// object so completion getters do not pass through Objective-C forwarding.
@interface MuTracerObservedCommandBuffer : NSObject {
    id<MTLCommandBuffer> _buffer;
    MuTracerRecord _record;
}
- (instancetype)initWithBuffer:(id<MTLCommandBuffer>)buffer record:(MuTracerRecord)record;
@end
@implementation MuTracerObservedCommandBuffer
+ (void)initialize { registerForwarders(self, @protocol(MTLCommandBuffer)); }
- (instancetype)initWithBuffer:(id<MTLCommandBuffer>)buffer record:(MuTracerRecord)record {
    self = [super init];
    if (self) { _buffer = buffer; _record = record; }
    return self;
}
- (id)forwardingTargetForSelector:(SEL)selector { return _buffer; }
- (BOOL)respondsToSelector:(SEL)selector {
    return [_buffer respondsToSelector:selector];
}
- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return [_buffer conformsToProtocol:protocol] || [super conformsToProtocol:protocol];
}
- (void)commit { _record((__bridge void *)_buffer); [_buffer commit]; }
@end

@interface MuTracerObservedQueue : NSObject {
    id<MTLCommandQueue> _queue;
    MuTracerRecord _record;
}
- (instancetype)initWithQueue:(id<MTLCommandQueue>)queue record:(MuTracerRecord)record;
@end

@implementation MuTracerObservedQueue
+ (void)initialize { registerForwarders(self, @protocol(MTLCommandQueue)); }
- (instancetype)initWithQueue:(id<MTLCommandQueue>)queue record:(MuTracerRecord)record {
    self = [super init];
    if (self) { _queue = queue; _record = record; }
    return self;
}
- (id)forwardingTargetForSelector:(SEL)selector { return _queue; }
- (BOOL)respondsToSelector:(SEL)selector {
    return [_queue respondsToSelector:selector];
}
- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return [_queue conformsToProtocol:protocol] || [super conformsToProtocol:protocol];
}
- (id<MTLCommandBuffer>)commandBuffer {
    id<MTLCommandBuffer> buffer = [_queue commandBuffer];
    return buffer ? (id<MTLCommandBuffer>)[[MuTracerObservedCommandBuffer alloc]
        initWithBuffer:buffer record:_record] : nil;
}
- (id<MTLCommandBuffer>)commandBufferWithUnretainedReferences {
    id<MTLCommandBuffer> buffer = [_queue commandBufferWithUnretainedReferences];
    return buffer ? (id<MTLCommandBuffer>)[[MuTracerObservedCommandBuffer alloc]
        initWithBuffer:buffer record:_record] : nil;
}
- (id<MTLCommandBuffer>)commandBufferWithDescriptor:(MTLCommandBufferDescriptor *)descriptor {
    id<MTLCommandBuffer> buffer = [_queue commandBufferWithDescriptor:descriptor];
    return buffer ? (id<MTLCommandBuffer>)[[MuTracerObservedCommandBuffer alloc]
        initWithBuffer:buffer record:_record] : nil;
}
@end

// Caller receives +1 ownership, matching Retained::from_raw.
__attribute__((visibility("hidden")))
void *mt_native_observe_metal_queue(void *queue, MuTracerRecord record) {
    return (__bridge_retained void *)[[MuTracerObservedQueue alloc]
        initWithQueue:(__bridge id<MTLCommandQueue>)queue record:record];
}
