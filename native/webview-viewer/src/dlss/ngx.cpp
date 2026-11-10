// MuTracer application-side NGX adapter; SDK headers are external dependencies.
#define NOMINMAX
#include <windows.h>
#include <vulkan/vulkan.h>
#include <nvsdk_ngx_helpers_vk.h>
#include <nvsdk_ngx_helpers_dlssd_vk.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <mutex>

#define API extern "C" __declspec(dllexport)
static std::mutex api_mutex;
static std::string project;
static std::wstring runtime_path, log_path;
static const wchar_t* search_paths[1];
static NVSDK_NGX_FeatureCommonInfo common{};
static NVSDK_NGX_Parameter* caps = nullptr;
static VkDevice active_device = VK_NULL_HANDLE;
static uint32_t requested_preset=0;
static bool verbose_logging=false;

struct Support {
    uint32_t size, result, supported, min_arch;
    char min_os[256];
};
struct Caps {
    uint32_t size, result;
    int32_t available, needs_driver;
    uint32_t min_driver_major, min_driver_minor;
    int32_t feature_init_result;
};
struct Texture {
    uint64_t image, view;
    uint32_t width, height, format, read_write;
};
struct Target { NVSDK_NGX_Handle* feature{}; NVSDK_NGX_Parameter* params{}; uint32_t width{},height{}; };

static void NVSDK_CONV logger(const char* message, NVSDK_NGX_Logging_Level, NVSDK_NGX_Feature) {
    // CRT serializes stderr; SDK may invoke this on arbitrary threads.
    if(verbose_logging) std::fprintf(stderr,"[NGX] %s\n",message);
}
static NVSDK_NGX_FeatureDiscoveryInfo discovery() {
    NVSDK_NGX_FeatureDiscoveryInfo d{};
    d.SDKVersion=NVSDK_NGX_Version_API;
    d.FeatureID=NVSDK_NGX_Feature_RayReconstruction;
    d.Identifier.IdentifierType=NVSDK_NGX_Application_Identifier_Type_Project_Id;
    d.Identifier.v.ProjectDesc={project.c_str(),NVSDK_NGX_ENGINE_TYPE_CUSTOM,"mutracer-viewer-1"};
    d.ApplicationDataPath=log_path.c_str(); d.FeatureInfo=&common;
    return d;
}
API uint32_t rr_abi() { return 2; }
API void rr_set_preset(uint32_t preset) {std::lock_guard guard(api_mutex);requested_preset=preset;}
API uint32_t rr_loaded_path(wchar_t* path,uint32_t capacity) {
    auto module=GetModuleHandleW(L"nvngx_dlssd.dll");
    return module ? GetModuleFileNameW(module,path,capacity) : 0;
}
API uint32_t rr_configure(const char* id, const wchar_t* runtime_dir, const wchar_t* logs) {
    std::lock_guard guard(api_mutex);
    project=id; runtime_path=runtime_dir; log_path=logs;
    search_paths[0]=runtime_path.c_str();
    common={}; common.PathListInfo={search_paths,1};
    common.LoggingInfo.LoggingCallback=logger;
    verbose_logging=GetEnvironmentVariableW(L"MUTRACER_DLSS_LOG",nullptr,0)>0;
    common.LoggingInfo.MinimumLoggingLevel=verbose_logging ? NVSDK_NGX_LOGGING_LEVEL_VERBOSE : NVSDK_NGX_LOGGING_LEVEL_OFF;
    common.LoggingInfo.DisableOtherLoggingSinks=true;
    return static_cast<uint32_t>(NVSDK_NGX_Result_Success);
}
API uint32_t rr_extensions(uint32_t device, uint64_t instance, uint64_t physical, char* names, uint32_t capacity, uint32_t* count) {
    std::lock_guard guard(api_mutex);
    auto d=discovery(); VkExtensionProperties* props=nullptr; uint32_t n=0;
    auto r=device ? NVSDK_NGX_VULKAN_GetFeatureDeviceExtensionRequirements(reinterpret_cast<VkInstance>(instance),reinterpret_cast<VkPhysicalDevice>(physical),&d,&n,&props)
                  : NVSDK_NGX_VULKAN_GetFeatureInstanceExtensionRequirements(&d,&n,&props);
    *count=n;
    if(NVSDK_NGX_FAILED(r)) return static_cast<uint32_t>(r);
    if(n>capacity || (n && !props)) return 0xbad00001;
    for(uint32_t i=0;i<n;++i) { std::memset(names+i*256,0,256); std::strncpy(names+i*256,props[i].extensionName,255); }
    return static_cast<uint32_t>(r);
}
API uint32_t rr_support(uint64_t instance,uint64_t physical,Support* output) {
    std::lock_guard guard(api_mutex);
    if(output->size!=sizeof(Support)) return 0xbad00002;
    auto d=discovery(); NVSDK_NGX_FeatureRequirement req{};
    auto r=NVSDK_NGX_VULKAN_GetFeatureRequirements(reinterpret_cast<VkInstance>(instance),reinterpret_cast<VkPhysicalDevice>(physical),&d,&req);
    output->result=static_cast<uint32_t>(r); output->supported=static_cast<uint32_t>(req.FeatureSupported);
    output->min_arch=req.MinHWArchitecture;
    if(req.MinOSVersion) std::strncpy(output->min_os,req.MinOSVersion,255);
    return static_cast<uint32_t>(r);
}
API uint32_t rr_init(uint64_t instance,uint64_t physical,uint64_t device,void* gipa,void* gdpa,Caps* output) {
    std::lock_guard guard(api_mutex);
    if(output->size!=sizeof(Caps)) return 0xbad00003;
    auto r=NVSDK_NGX_VULKAN_Init_with_ProjectID(project.c_str(),NVSDK_NGX_ENGINE_TYPE_CUSTOM,"mutracer-viewer-1",log_path.c_str(),reinterpret_cast<VkInstance>(instance),reinterpret_cast<VkPhysicalDevice>(physical),reinterpret_cast<VkDevice>(device),reinterpret_cast<PFN_vkGetInstanceProcAddr>(gipa),reinterpret_cast<PFN_vkGetDeviceProcAddr>(gdpa),&common);
    if(NVSDK_NGX_FAILED(r)) { output->result=static_cast<uint32_t>(r); return output->result; }
    active_device=reinterpret_cast<VkDevice>(device);
    r=NVSDK_NGX_VULKAN_GetCapabilityParameters(&caps);
    output->result=static_cast<uint32_t>(r);
    if(NVSDK_NGX_SUCCEED(r)) {
        caps->Get(NVSDK_NGX_Parameter_SuperSamplingDenoising_Available,&output->available);
        caps->Get(NVSDK_NGX_Parameter_SuperSamplingDenoising_NeedsUpdatedDriver,&output->needs_driver);
        caps->Get(NVSDK_NGX_Parameter_SuperSamplingDenoising_MinDriverVersionMajor,&output->min_driver_major);
        caps->Get(NVSDK_NGX_Parameter_SuperSamplingDenoising_MinDriverVersionMinor,&output->min_driver_minor);
        caps->Get(NVSDK_NGX_Parameter_SuperSamplingDenoising_FeatureInitResult,&output->feature_init_result);
    }
    return output->result;
}
API uint32_t rr_create(uint64_t cmd,uint32_t width,uint32_t height,void** target) {
    std::lock_guard guard(api_mutex);
    auto t=new Target{}; t->width=width; t->height=height; *target=t;
    auto r=NVSDK_NGX_VULKAN_AllocateParameters(&t->params);
    if(NVSDK_NGX_FAILED(r)) return static_cast<uint32_t>(r);
    // NGX validates preset choices for every mode during creation, even when
    // this feature is created in DLAA. Set all mode hints consistently.
    const char* preset_keys[]={NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_DLAA,NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_Quality,NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_Balanced,NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_Performance,NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_UltraPerformance,NVSDK_NGX_Parameter_RayReconstruction_Hint_Render_Preset_UltraQuality};
    for(auto key:preset_keys) t->params->Set(key,requested_preset);
    NVSDK_NGX_DLSSD_Create_Params p{};
    p.InWidth=width;p.InHeight=height;p.InTargetWidth=width;p.InTargetHeight=height;
    p.InPerfQualityValue=NVSDK_NGX_PerfQuality_Value_DLAA;
    p.InDenoiseMode=NVSDK_NGX_DLSS_Denoise_Mode_DLUnified;
    p.InRoughnessMode=NVSDK_NGX_DLSS_Roughness_Mode_Packed;
    p.InUseHWDepth=NVSDK_NGX_DLSS_Depth_Type_Linear;
    p.InFeatureCreateFlags=NVSDK_NGX_DLSS_Feature_Flags_IsHDR | NVSDK_NGX_DLSS_Feature_Flags_MVLowRes;
    r=NGX_VULKAN_CREATE_DLSSD_EXT1(active_device,reinterpret_cast<VkCommandBuffer>(cmd),1,1,&t->feature,t->params,&p);
    return static_cast<uint32_t>(r);
}
API uint32_t rr_eval(void* target,uint64_t cmd,const Texture* images,uint32_t count,uint32_t reset,float jitter_x,float jitter_y,const float* view,const float* proj,float delta_ms) {
    std::lock_guard guard(api_mutex);
    if(count!=8 || !target) return 0xbad00004;
    auto t=static_cast<Target*>(target);
    NVSDK_NGX_Resource_VK resources[8]{};
    VkImageSubresourceRange range{VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
    for(uint32_t i=0;i<count;++i) {
        if(!images[i].image) continue;
        resources[i]=NVSDK_NGX_Create_ImageView_Resource_VK(reinterpret_cast<VkImageView>(images[i].view),reinterpret_cast<VkImage>(images[i].image),range,static_cast<VkFormat>(images[i].format),images[i].width,images[i].height,images[i].read_write!=0);
    }
    NVSDK_NGX_VK_DLSSD_Eval_Params p{};
    p.pInColor=&resources[0];p.pInDiffuseAlbedo=&resources[1];p.pInSpecularAlbedo=&resources[2];
    p.pInNormals=&resources[3];p.pInDepth=&resources[4];p.pInMotionVectors=&resources[5];
    p.pInSpecularHitDistance=images[6].image ? &resources[6] : nullptr;p.pInOutput=&resources[7];
    p.InRenderSubrectDimensions={t->width,t->height}; p.InReset=reset;
    p.InJitterOffsetX=jitter_x;p.InJitterOffsetY=jitter_y;p.InMVScaleX=1;p.InMVScaleY=1;
    p.InPreExposure=1;p.InExposureScale=1;p.InFrameTimeDeltaInMsec=delta_ms;
    p.pInWorldToViewMatrix=const_cast<float*>(view);p.pInViewToClipMatrix=const_cast<float*>(proj);
    return static_cast<uint32_t>(NGX_VULKAN_EVALUATE_DLSSD_EXT(reinterpret_cast<VkCommandBuffer>(cmd),t->feature,t->params,&p));
}
API uint32_t rr_release(void* target) {
    std::lock_guard guard(api_mutex);
    auto t=static_cast<Target*>(target); if(!t) return static_cast<uint32_t>(NVSDK_NGX_Result_Success);
    auto r=NVSDK_NGX_Result_Success;
    if(t->feature) r=NVSDK_NGX_VULKAN_ReleaseFeature(t->feature);
    if(t->params) NVSDK_NGX_VULKAN_DestroyParameters(t->params);
    delete t;return static_cast<uint32_t>(r);
}
API uint32_t rr_shutdown() {
    std::lock_guard guard(api_mutex);
    if(caps) NVSDK_NGX_VULKAN_DestroyParameters(caps);caps=nullptr;
    auto r=active_device ? NVSDK_NGX_VULKAN_Shutdown1(active_device) : NVSDK_NGX_Result_Success;
    active_device=VK_NULL_HANDLE;return static_cast<uint32_t>(r);
}
