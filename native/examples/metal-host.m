/* Metal host with an independent queue. Build/run: node native/validation/metal-render.mjs.
 * Fixed seed and samples. Exported pixels are consumed/checked on GPU; only a
 * mismatch counter reaches CPU. Readback is used solely as an independent oracle.
 */
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "mutracer-metal.h"
#include "mutracer-log.h"
#include "mutracer-scene-builder.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#define REQUIRE(x) do { if (!(x)) { fprintf(stderr,"Failed: %s (%s:%d)\n",#x,__FILE__,__LINE__); exit(1); } } while(0)
#define CHECK(x) do { mt_status call_status=(x); if(call_status!=MT_OK){fprintf(stderr,"%s: %d %s\n",#x,call_status,error);exit(1);} } while(0)
_Static_assert(MT_GPU_OUTPUT_HDR==0 && MT_GPU_OUTPUT_DEPTH==1 &&
  MT_GPU_OUTPUT_DISPLAY==2 && MT_GPU_OUTPUT_CENTER_DEPTH==3, "GPU kind ABI");
static char error[4096];
static void log_message(void *user,const uint8_t *message,size_t length) {
  (void)user;
  if(length && message[0]=='{' && memmem(message,length,"metalExportGpuMs",16))printf("GPU %.*s\n",(int)length,message);
}
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec*1e-9; }
static mt_scene_builder scene(uint32_t width,uint32_t height,int opaque) {
  const float positions[]={-1,0,-1,-1,0,1,1,0,-1,1,0,1}; const uint32_t indices[]={0,1,2,2,1,3};
  mt_scene_builder b;mt_scene_builder_init(&b);
  mt_geometry_v4 g={0};g.vertex_count=4;g.index_count=6;
  g.position_offset=mt_scene_builder_append(&b,positions,sizeof positions);g.index_offset=mt_scene_builder_append(&b,indices,sizeof indices);
  mt_mesh_v4 m={0};mt_scene_identity(m.world_matrix);
  mt_material_v4 mat=mt_material_v4_default();mat.base_color[1]=.13f;mat.base_color[2]=.07f;
  mt_light_v4 light={0};light.type=MT_LIGHT_TYPE_RECT;light.color[0]=light.color[1]=light.color[2]=1;light.intensity=10;
  light.size_or_radius=light.height_or_inner_angle=1;light.spread_or_outer_angle=1;
  const float at[]={0,2,0},to[]={0,0,.001f};mt_scene_look_at(light.world_matrix,at,to);
  mt_camera_v4 camera=mt_camera_v4_default();const float eye[]={0,2,3},target[]={0,0,0};mt_scene_look_at(camera.world_matrix,eye,target);
  mt_scene_header_v4 h={0};h.width=width;h.height=height;h.background_color[0]=.08f;h.background_color[1]=.11f;h.background_color[2]=.17f;h.background_color[3]=opaque?1:0;h.geometry_count=h.mesh_count=h.material_count=h.light_count=1;
  h.geometry_offset=mt_scene_builder_append(&b,&g,sizeof g);h.mesh_offset=mt_scene_builder_append(&b,&m,sizeof m);h.material_offset=mt_scene_builder_append(&b,&mat,sizeof mat);
  h.light_offset=mt_scene_builder_append(&b,&light,sizeof light);h.camera_offset=mt_scene_builder_append(&b,&camera,sizeof camera);
  REQUIRE(mt_scene_builder_finish(&b,&h));return b;
}
static id<MTLTexture> texture(id<MTLDevice> device,MTLPixelFormat format,uint32_t w,uint32_t h) {
  MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];
  d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;d.storageMode=MTLStorageModePrivate;
  id<MTLTexture> t=[device newTextureWithDescriptor:d];REQUIRE(t);return t;
}
static mt_gpu_image import_image(mt_engine engine,id<MTLTexture> t) {
  mt_metal_image_desc d={sizeof d,0,NULL,(__bridge void *)t};mt_gpu_image image=0;
  CHECK(mt_engine_import_metal_image(engine,&d,&image,error,sizeof error));return image;
}
static mt_gpu_timeline import_event(mt_engine engine,id<MTLSharedEvent> e) {
  mt_metal_timeline_desc d={sizeof d,0,NULL,(__bridge void *)e};mt_gpu_timeline timeline=0;
  CHECK(mt_engine_import_metal_timeline(engine,&d,&timeline,error,sizeof error));return timeline;
}
static uint64_t submit(mt_render render,mt_gpu_export_image *images,uint32_t count,mt_gpu_timeline ready,uint64_t rv,mt_gpu_timeline done,uint64_t dv) {
  mt_gpu_export_desc d={sizeof d,count,NULL,images,ready,rv,done,dv};uint64_t seq=0;
  CHECK(mt_render_export_gpu(render,&d,&seq,error,sizeof error));REQUIRE(seq);return seq;
}
static void signal_event(id<MTLCommandQueue> q,id<MTLSharedEvent> event,uint64_t value) {
  id<MTLCommandBuffer> b=[q commandBuffer];[b encodeSignalEvent:event value:value];[b commit];
}
static void wait_exports(mt_engine engine,uint64_t sequence) {
  double end=now()+30;uint32_t complete=0;
  while(!complete){CHECK(mt_engine_gpu_poll(engine,sequence,&complete,error,sizeof error));REQUIRE(now()<end);if(!complete)[NSThread sleepForTimeInterval:.0001];}
}
static float *readback(mt_render render,uint32_t kind,size_t bytes) {
  float *p=malloc(bytes);REQUIRE(p);size_t written=0;CHECK(mt_render_read_pixels(render,kind,p,bytes,&written,error,sizeof error));REQUIRE(written==bytes);return p;
}
/* format: 0 RGBA32, 1 depth RGBA32, 2 depth R32, 3 half RGBA, 4 display bytes. */
static id<MTLComputePipelineState> checker(id<MTLDevice> device) {
  NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\nkernel void check(texture2d<float,access::read> image [[texture(0)]], device const uint4 *expected [[buffer(0)]], device atomic_uint *errors [[buffer(1)]], constant uint4 &p [[buffer(2)]], uint2 id [[thread_position_in_grid]]) { if(any(id>=p.xy))return; uint2 src=uint2(id.x,p.w?p.y-1-id.y:id.y); uint4 e=expected[src.x+src.y*p.x];float4 v=image.read(id);uint4 a=as_type<uint4>(v); if(p.z==2){a=uint4(a.x,0,0,0);e=uint4(e.x,0,0,0);} if(p.z==3){e=as_type<uint4>(float4(half4(as_type<float4>(e))));} if(p.z==4){a=uint4(round(v*255.0f));e=uint4(as_type<float4>(e));} if(any(a!=e)){uint old=atomic_fetch_add_explicit(errors,1,memory_order_relaxed);if(old==0){for(uint c=0;c<4;c++){atomic_store_explicit(errors+1+c,a[c],memory_order_relaxed);atomic_store_explicit(errors+5+c,e[c],memory_order_relaxed);}}} }";
  NSError *err=nil;MTLCompileOptions *compile=[MTLCompileOptions new];compile.mathMode=MTLMathModeSafe;compile.mathFloatingPointFunctions=MTLMathFloatingPointFunctionsPrecise;id<MTLLibrary> lib=[device newLibraryWithSource:source options:compile error:&err];REQUIRE(lib);
  id<MTLComputePipelineState> pipeline=[device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"check"] error:&err];REQUIRE(pipeline);return pipeline;
}
static double check_gpu(id<MTLDevice> device,id<MTLCommandQueue> queue,id<MTLComputePipelineState> pipeline,id<MTLTexture> t,const float *expected,uint32_t format,uint32_t flip,id<MTLSharedEvent> done,uint64_t dv,id<MTLSharedEvent> ready,uint64_t rv) {
  size_t bytes=t.width*t.height*16;id<MTLBuffer> reference=[device newBufferWithBytes:expected length:bytes options:MTLResourceStorageModeShared];
  id<MTLBuffer> errors=[device newBufferWithLength:36 options:MTLResourceStorageModeShared];*(uint32_t *)errors.contents=0;
  id<MTLCommandBuffer> commands=[queue commandBuffer];[commands encodeWaitForEvent:done value:dv];
  id<MTLComputeCommandEncoder> encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:pipeline];[encoder setTexture:t atIndex:0];[encoder setBuffer:reference offset:0 atIndex:0];[encoder setBuffer:errors offset:0 atIndex:1];
  uint32_t params[]={(uint32_t)t.width,(uint32_t)t.height,format,flip};[encoder setBytes:params length:sizeof params atIndex:2];
  [encoder dispatchThreads:MTLSizeMake(t.width,t.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
  if(ready)[commands encodeSignalEvent:ready value:rv];[commands commit];[commands waitUntilCompleted];
  if(commands.status!=MTLCommandBufferStatusCompleted)fprintf(stderr,"consumer format=%u done=%llu ready=%llu status=%lu error=%s\n",format,(unsigned long long)dv,(unsigned long long)done.signaledValue,(unsigned long)commands.status,commands.error.description.UTF8String);
  REQUIRE(commands.status==MTLCommandBufferStatusCompleted);uint32_t count=*(uint32_t *)errors.contents;
  if(count){fprintf(stderr,"GPU mismatches format=%u flip=%u: %u\n",format,flip,count);uint32_t *v=errors.contents;for(unsigned c=0;c<4;c++)fprintf(stderr,"%08x / %08x\n",v[1+c],v[5+c]);}REQUIRE(count==0);
  return (commands.GPUEndTime-commands.GPUStartTime)*1000;
}
static void converge(mt_render render,uint32_t samples) {
  mt_converge_options c;CHECK(mt_converge_options_default(samples,&c));c.samples=samples;c.samples_per_batch=1;CHECK(mt_render_converge(render,&c,NULL,error,sizeof error));
}
static mt_render_snapshot info(mt_render render) {
  mt_render_snapshot s={0};s.struct_size=sizeof s;CHECK(mt_render_info(render,&s,error,sizeof error));return s;
}
int main(int argc,char **argv) { @autoreleasepool {
  REQUIRE(mt_abi_version()==MT_ABI_VERSION && MT_ABI_VERSION==11);
  unsigned backend=argc>1?(unsigned)atoi(argv[1]):0;BOOL gpu_timing=argc>2&&!strcmp(argv[2],"--gpu-timing");BOOL bench=gpu_timing||(argc>2&&!strcmp(argv[2],"--bench"));BOOL shared=argc>2&&!strcmp(argv[2],"--shared");
  if(bench)CHECK(mt_set_log_callback(log_message,NULL));
  id<MTLDevice> device=MTLCreateSystemDefaultDevice();REQUIRE(device);id<MTLCommandQueue> host=[device newCommandQueueWithMaxCommandBufferCount:4096];id<MTLCommandQueue> producer=[device newCommandQueue];REQUIRE(host&&producer);
  mt_metal_device_desc dd={sizeof dd,0,NULL,(__bridge void *)device,shared?(__bridge void *)host:NULL};
  mt_engine_options eo;CHECK(mt_engine_options_default(&eo));eo.backend=backend;mt_engine engine=0;CHECK(mt_engine_create_metal(&dd,&eo,&engine,error,sizeof error));
  mt_engine_snapshot es={0};es.struct_size=sizeof es;CHECK(mt_engine_info(engine,&es,error,sizeof error));REQUIRE(!backend||es.hardware_ray_query);
  uint32_t width=96,height=64;mt_scene_builder b=scene(width,height,0);CHECK(mt_engine_set_scene(engine,mt_scene_builder_bytes(&b),b.used * sizeof(uint32_t),error,sizeof error));mt_scene_builder_free(&b);CHECK(mt_engine_update(engine,NULL,error,sizeof error));
  mt_render_options ro;CHECK(mt_render_options_default(&ro));ro.width=width;ro.height=height;ro.max_samples=16384;ro.seed=12345;ro.aovs=MT_AOV_DEPTH;ro.aov_samples=4;ro.bevel=0;
  mt_render render=0;CHECK(mt_render_create(engine,&ro,&render,error,sizeof error));converge(render,4);REQUIRE(info(render).backend==backend);
  id<MTLSharedEvent> ready=[device newSharedEvent],done=[device newSharedEvent];REQUIRE(ready&&done);
  mt_gpu_timeline ri=import_event(engine,ready),di=import_event(engine,done);
  id<MTLComputePipelineState> pipeline=checker(device);uint64_t dv=0,rv=0,sequence=0;
  id<MTLTexture> hdr=texture(device,MTLPixelFormatRGBA32Float,width,height),depth=texture(device,MTLPixelFormatRGBA32Float,width,height);
  mt_gpu_image hi=import_image(engine,hdr),zi=import_image(engine,depth);
  mt_gpu_export_image images[]={{sizeof images[0],MT_GPU_OUTPUT_HDR,NULL,hi,MT_GPU_TOP_FIRST,0},{sizeof images[0],MT_GPU_OUTPUT_DEPTH,NULL,zi,MT_GPU_TOP_FIRST,0}};
  for(unsigned frame=0;frame<4;frame++) {
    if(frame)converge(render,4+frame);
    size_t bytes=(size_t)width*height*16;float *h=readback(render,MT_IMAGE_HDR,bytes),*z=readback(render,MT_IMAGE_DEPTH,bytes);
    signal_event(producer,ready,++rv);sequence=submit(render,images,2,ri,rv,di,++dv);
    check_gpu(device,host,pipeline,hdr,h,0,0,done,dv,nil,0);check_gpu(device,host,pipeline,depth,z,1,0,done,dv,nil,0);wait_exports(engine,sequence);free(h);free(z);
  }
  /* Conversion and orientation: compare GPU against the same readback oracle. */
  MTLPixelFormat formats[]={MTLPixelFormatRGBA16Float,MTLPixelFormatR32Float};
  for(unsigned f=0;f<2;f++)for(unsigned flip=0;flip<2;flip++) {
    id<MTLTexture> t=texture(device,formats[f],width,height);mt_gpu_image ti=import_image(engine,t);
    mt_gpu_export_image image={sizeof image,f?MT_GPU_OUTPUT_DEPTH:MT_GPU_OUTPUT_HDR,NULL,ti,flip,0};
    float *p=readback(render,f?MT_IMAGE_DEPTH:MT_IMAGE_HDR,(size_t)width*height*16);
    sequence=submit(render,&image,1,0,0,di,++dv);CHECK(mt_gpu_image_destroy(ti,error,sizeof error));
    check_gpu(device,host,pipeline,t,p,f?2:3,flip,done,dv,nil,0);wait_exports(engine,sequence);free(p);
  }
  for(unsigned k=0;k<2;k++) {
    images[k].row_order=MT_GPU_BOTTOM_FIRST;float *p=readback(render,k?MT_IMAGE_DEPTH:MT_IMAGE_HDR,(size_t)width*height*16);
    sequence=submit(render,&images[k],1,0,0,di,++dv);check_gpu(device,host,pipeline,k?depth:hdr,p,k,1,done,dv,nil,0);wait_exports(engine,sequence);free(p);images[k].row_order=MT_GPU_TOP_FIRST;
  }
  mt_display display=0;CHECK(mt_engine_display(engine,&display,error,sizeof error));
  CHECK(mt_display_present(display,render,NULL,NULL,error,sizeof error));
  size_t rgba_size=(size_t)width*height*4,written=0;uint8_t *rgba=malloc(rgba_size);float *rgba_reference=malloc(rgba_size*4);REQUIRE(rgba&&rgba_reference);
  CHECK(mt_display_read_pixels(display,render,MT_DISPLAY_RGBA8,rgba,rgba_size,&written,NULL,NULL,error,sizeof error));REQUIRE(written==rgba_size);
  for(size_t j=0;j<rgba_size;j++)rgba_reference[j]=rgba[j];
  id<MTLTexture> display_texture=texture(device,MTLPixelFormatRGBA8Unorm,width,height);mt_gpu_image display_image=import_image(engine,display_texture);
  mt_gpu_export_image display_export={sizeof display_export,MT_GPU_OUTPUT_DISPLAY,NULL,display_image,0,0};
  sequence=submit(render,&display_export,1,0,0,di,++dv);check_gpu(device,host,pipeline,display_texture,rgba_reference,4,0,done,dv,nil,0);wait_exports(engine,sequence);
  /* Center depth is opt-in. Rejection must leave sequence and sync untouched. */
  mt_gpu_export_image center_export={sizeof center_export,MT_GPU_OUTPUT_CENTER_DEPTH,NULL,zi,0,0};
  mt_gpu_export_desc center_desc={sizeof center_desc,1,NULL,&center_export,0,0,di,dv+1};
  uint64_t center_rejected=999;
  REQUIRE(mt_render_export_gpu(render,&center_desc,&center_rejected,error,sizeof error)==MT_ERROR_INVALID_STATE && center_rejected==0);
  REQUIRE(done.signaledValue==dv);
  float *old_hdr=readback(render,MT_IMAGE_HDR,(size_t)width*height*16);
  float *old_depth=readback(render,MT_IMAGE_DEPTH,(size_t)width*height*16);
  ro.aovs|=MT_AOV_CENTER_DEPTH;CHECK(mt_render_set_options(render,&ro,error,sizeof error));converge(render,7);
  float *new_hdr=readback(render,MT_IMAGE_HDR,(size_t)width*height*16);
  float *new_depth=readback(render,MT_IMAGE_DEPTH,(size_t)width*height*16);
  REQUIRE(!memcmp(old_hdr,new_hdr,(size_t)width*height*16));REQUIRE(!memcmp(old_depth,new_depth,(size_t)width*height*16));
  sequence=submit(render,images,2,0,0,di,++dv);
  check_gpu(device,host,pipeline,hdr,old_hdr,0,0,done,dv,nil,0);check_gpu(device,host,pipeline,depth,old_depth,1,0,done,dv,nil,0);wait_exports(engine,sequence);
  CHECK(mt_display_present(display,render,NULL,NULL,error,sizeof error));
  sequence=submit(render,&display_export,1,0,0,di,++dv);check_gpu(device,host,pipeline,display_texture,rgba_reference,4,0,done,dv,nil,0);wait_exports(engine,sequence);
  free(old_hdr);free(old_depth);free(new_hdr);free(new_depth);free(rgba);free(rgba_reference);CHECK(mt_gpu_image_destroy(display_image,error,sizeof error));
  float *center_reference=readback(render,MT_IMAGE_CENTER_DEPTH,(size_t)width*height*16);
  unsigned hits=0,misses=0,different=0;
  float *averaged=readback(render,MT_IMAGE_DEPTH,(size_t)width*height*16);
  for(size_t i=0;i<(size_t)width*height;i++) {
    REQUIRE(center_reference[i*4+3]==0 || center_reference[i*4+3]==1);
    if(center_reference[i*4+3])hits++;else misses++;
    different+=memcmp(center_reference+i*4,averaged+i*4,16)!=0;
  }
  REQUIRE(hits && misses && different);free(averaged);
  for(unsigned r32=0;r32<2;r32++)for(unsigned flip=0;flip<2;flip++) {
    id<MTLTexture> t=texture(device,r32?MTLPixelFormatR32Float:MTLPixelFormatRGBA32Float,width,height);
    mt_gpu_image ti=import_image(engine,t);center_export.image=ti;center_export.row_order=flip;
    sequence=submit(render,&center_export,1,0,0,di,++dv);
    check_gpu(device,host,pipeline,t,center_reference,r32?2:1,flip,done,dv,nil,0);wait_exports(engine,sequence);CHECK(mt_gpu_image_destroy(ti,error,sizeof error));
  }
  free(center_reference);
  /* Imported supported formats/sizes can still be wrong for this output kind. */
  for(unsigned wrong_size=0;wrong_size<2;wrong_size++) {
    id<MTLTexture> t=texture(device,wrong_size?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float,wrong_size?width+1:width,height);
    mt_gpu_image ti=import_image(engine,t);center_export.image=ti;center_desc.done_value=dv+1;
    center_rejected=999;
    REQUIRE(mt_render_export_gpu(render,&center_desc,&center_rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT && center_rejected==0);
    REQUIRE(done.signaledValue==dv);CHECK(mt_gpu_image_destroy(ti,error,sizeof error));
  }
  printf("PASS center depth: %u hits, %u misses, %u different from averaged; both formats/rows, opt-in/format/size rejection; old HDR/depth/display unchanged\n",hits,misses,different);
  /* Opaque flat background adds coverage restoration to the CPU HDR contract. */
  mt_scene_builder flat=scene(width,height,1);CHECK(mt_engine_set_scene(engine,mt_scene_builder_bytes(&flat),flat.used*sizeof(uint32_t),error,sizeof error));mt_scene_builder_free(&flat);CHECK(mt_engine_update(engine,NULL,error,sizeof error));converge(render,7);
  float *flat_reference=readback(render,MT_IMAGE_HDR,(size_t)width*height*16);sequence=submit(render,images,2,0,0,di,++dv);check_gpu(device,host,pipeline,hdr,flat_reference,0,0,done,dv,nil,0);wait_exports(engine,sequence);free(flat_reference);
  /* Rejected arguments never touch done. Reimport cannot reset signal history. */
  mt_gpu_export_desc desc={sizeof desc,2,NULL,images,0,0,di,dv};uint64_t rejected=999;
  REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);
  mt_gpu_timeline alias=import_event(engine,done);desc.done=alias;REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);CHECK(mt_gpu_timeline_destroy(alias,error,sizeof error));desc.done=di;
  desc.done_value=UINT64_MAX;REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);
  desc.done_value=dv+1;desc.next=&desc;REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);desc.next=NULL;
  desc.ready=di;desc.ready_value=desc.done_value;REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);
  /* Delayed readiness: no GPU completion until an independent producer signals.
   * Accepted exports survive cancellation and import-handle release. */
  float *expected=readback(render,MT_IMAGE_HDR,(size_t)width*height*16);
  double started=now();sequence=submit(render,images,2,ri,++rv,di,++dv);double submit_ms=(now()-started)*1000;REQUIRE(submit_ms<1000);
  for(unsigned pending=1;pending<32;pending++)sequence=submit(render,images,2,ri,rv,di,++dv);
  mt_gpu_export_desc full={sizeof full,2,NULL,images,0,0,di,dv+1};
  mt_status full_status=mt_render_export_gpu(render,&full,&rejected,error,sizeof error);if(full_status!=MT_ERROR_BUSY)fprintf(stderr,"full status=%d sequence=%llu done=%llu: %s\n",full_status,(unsigned long long)rejected,(unsigned long long)done.signaledValue,error);REQUIRE(full_status==MT_ERROR_BUSY&&rejected==0);
  uint32_t complete=1;CHECK(mt_engine_gpu_poll(engine,sequence,&complete,error,sizeof error));REQUIRE(!complete);
  CHECK(mt_render_cancel(render,error,sizeof error));REQUIRE(mt_engine_destroy(engine,error,sizeof error)==MT_ERROR_BUSY);
  CHECK(mt_gpu_image_destroy(hi,error,sizeof error));CHECK(mt_gpu_image_destroy(zi,error,sizeof error));
  [NSThread sleepForTimeInterval:.05];REQUIRE(done.signaledValue<dv);
  uint64_t ready_after_delay=rv;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),dispatch_get_global_queue(QOS_CLASS_DEFAULT,0),^{signal_event(producer,ready,ready_after_delay);});
  ro.width=48;ro.height=32;CHECK(mt_render_set_options(render,&ro,error,sizeof error));
  check_gpu(device,host,pipeline,hdr,expected,0,0,done,dv,nil,0);wait_exports(engine,sequence);free(expected);
  /* Resolution changes reject stale imports; a matching new image succeeds. */
  hi=import_image(engine,hdr);images[0].image=hi;ro.width=48;ro.height=32;CHECK(mt_render_set_options(render,&ro,error,sizeof error));converge(render,4);
  desc=(mt_gpu_export_desc){sizeof desc,1,NULL,images,0,0,di,dv+1};REQUIRE(mt_render_export_gpu(render,&desc,&rejected,error,sizeof error)==MT_ERROR_INVALID_ARGUMENT&&rejected==0);CHECK(mt_gpu_image_destroy(hi,error,sizeof error));
  hdr=texture(device,MTLPixelFormatRGBA32Float,48,32);hi=import_image(engine,hdr);images[0].image=hi;expected=readback(render,MT_IMAGE_HDR,48*32*16);
  sequence=submit(render,images,1,0,0,di,++dv);check_gpu(device,host,pipeline,hdr,expected,0,0,done,dv,nil,0);wait_exports(engine,sequence);free(expected);CHECK(mt_gpu_image_destroy(hi,error,sizeof error));
  if(bench) {
    const unsigned sizes[][2]={{1280,720},{1920,1080},{3840,2160}};
    for(unsigned n=0;n<3;n++) {
      width=sizes[n][0];height=sizes[n][1];ro.width=width;ro.height=height;ro.aov_samples=1;CHECK(mt_render_set_options(render,&ro,error,sizeof error));converge(render,4);
      hdr=texture(device,MTLPixelFormatRGBA32Float,width,height);depth=texture(device,MTLPixelFormatR32Float,width,height);hi=import_image(engine,hdr);zi=import_image(engine,depth);images[0].image=hi;images[1].image=zi;
      uint64_t first_sequence=sequence+1;double cpu=0,cpu_depth=0,export_cpu=0,gpu_wall=0;size_t bytes=(size_t)width*height*16;float *p=malloc(bytes);REQUIRE(p);
      for(unsigned j=0;j<9;j++) {
        size_t written=0;double a=now();CHECK(mt_render_read_pixels(render,MT_IMAGE_HDR,p,bytes,&written,error,sizeof error));double b=now();CHECK(mt_render_read_pixels(render,MT_IMAGE_DEPTH,p,bytes,&written,error,sizeof error));double b_depth=now();
        /* GPUStart/EndTime of a marker brackets SDK work using host timeline. */
        id<MTLCommandBuffer> before=[producer commandBuffer];[before encodeSignalEvent:ready value:++rv];[before commit];[before waitUntilCompleted];
        double c=now();sequence=submit(render,images,2,ri,rv,di,++dv);double d=now();
        id<MTLCommandBuffer> after=[host commandBuffer];[after encodeWaitForEvent:done value:dv];[after commit];[after waitUntilCompleted];wait_exports(engine,sequence);
        if(j){cpu+=(b-a)*1000;cpu_depth+=(b_depth-b)*1000;export_cpu+=(d-c)*1000;gpu_wall+=(after.GPUEndTime-before.GPUEndTime)*1000;}
      }
      printf("BENCH {\"backend\":%u,\"width\":%u,\"height\":%u,\"firstSequence\":%llu,\"lastSequence\":%llu,\"readbackCpuMs\":%.6f,\"depthReadbackCpuMs\":%.6f,\"exportCpuMs\":%.6f,\"gpuTimelineMs\":%.6f}\n",backend,width,height,(unsigned long long)first_sequence,(unsigned long long)sequence,cpu/8,cpu_depth/8,export_cpu/8,gpu_wall/8);free(p);
      /* Refinement throughput, restart identically, export every completed sample
       * or at most 60 Hz; final collect can have one sample in flight. */
      for(unsigned mode=0;!gpu_timing&&mode<3;mode++) {
        CHECK(mt_render_restart(render,error,sizeof error));double start=now(),next=0;uint32_t exports=0,last_samples=0;
        while(now()-start<2.0) {
          CHECK(mt_render_refine(render,NULL,error,sizeof error));mt_render_snapshot snap=info(render);
          if(snap.samples>last_samples&&now()>=next) {
            last_samples=snap.samples;
            if(mode==0){size_t written=0;float *pixels=malloc(bytes);REQUIRE(pixels);CHECK(mt_render_read_pixels(render,MT_IMAGE_HDR,pixels,bytes,&written,error,sizeof error));CHECK(mt_render_read_pixels(render,MT_IMAGE_DEPTH,pixels,bytes,&written,error,sizeof error));free(pixels);}
            else {uint32_t drained=0;CHECK(mt_engine_gpu_poll(engine,0,&drained,error,sizeof error));sequence=submit(render,images,2,0,0,di,++dv);exports++;}
            next=now()+(mode==2?1.0/60:0);
          }
        }
        uint32_t idle=0;while(!idle){CHECK(mt_render_collect(render,&idle,error,sizeof error));}wait_exports(engine,0);
        double elapsed=now()-start;mt_render_snapshot snap=info(render);
        printf("THROUGHPUT {\"backend\":%u,\"width\":%u,\"height\":%u,\"mode\":%u,\"samples\":%u,\"seconds\":%.6f,\"samplesPerSecond\":%.6f,\"exports\":%u}\n",backend,width,height,mode,snap.samples,elapsed,snap.samples/elapsed,exports);
      }
      CHECK(mt_gpu_image_destroy(hi,error,sizeof error));CHECK(mt_gpu_image_destroy(zi,error,sizeof error));
    }
  }
  CHECK(mt_gpu_timeline_destroy(ri,error,sizeof error));CHECK(mt_gpu_timeline_destroy(di,error,sizeof error));wait_exports(engine,0);CHECK(mt_engine_destroy(engine,error,sizeof error));
  REQUIRE(mt_gpu_timeline_destroy(di,error,sizeof error)==MT_ERROR_INVALID_HANDLE);
  printf("PASS Metal GPU export backend=%u shared=%d delayedSubmitMs=%.4f\n",backend,shared,submit_ms);return 0;
} }
