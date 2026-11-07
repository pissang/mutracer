/* Performance evidence, not a CI gate. Each edit is isolated by an unmeasured
 * inverse edit + commit. stdout is JSONL; stderr contains SDK errors.
 * Usage: edit-cost-host backend meshes materials lights grid instances repeats width height [case]
 * grid is the number of quads per side in EACH independent geometry. */
#define _POSIX_C_SOURCE 200809L
#include "mutracer-scene-api.h"
#include "mutracer-scene-builder.h"
#include "mutracer-log.h"
#include "host-time.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#define CHECK(call) do {int32_t code=(call);if(code!=MT_OK){fprintf(stderr,"%s: %d %s\n",#call,code,error);exit(1);}}while(0)
static char error[4096];
static void log_message(void *user,const uint8_t *message,size_t length){(void)user;fwrite(message,1,length,stderr);fputc('\n',stderr);}
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000.+t.tv_nsec/1e6;}
static void *alloc(size_t n,size_t s){void *p=calloc(n,s);if(!p){fprintf(stderr,"allocation failed\n");exit(1);}return p;}
static uint32_t number(const char *s,uint32_t min,uint32_t max){char *end;unsigned long n=strtoul(s,&end,10);if(!*s||*end||n<min||n>max){fprintf(stderr,"invalid argument: %s (%u..%u)\n",s,min,max);exit(1);}return (uint32_t)n;}
/* A comma-separated filter keeps a group of edits in one engine/process. */
static int selected(const char *filter,const char *name){
  if(!filter)return 1;
  size_t length=strlen(name);
  for(const char *at=filter;*at;){const char *end=strchr(at,',');size_t n=end?(size_t)(end-at):strlen(at);if(n==length&&!memcmp(at,name,n))return 1;if(!end)break;at=end+1;}
  return 0;
}
typedef struct {
  mt_scene scene;mt_engine engine;mt_render render;
  mt_scene_geometry_id geometry,extra_geometry;mt_scene_material_id material;
  mt_scene_mesh_id mesh,extra,batch;mt_scene_light_id light,extra_light;
  mt_scene_texture_id textures[4];
  mt_scene_geometry_desc gd;mt_scene_texture_desc td;mt_scene_mesh_desc md;
  mt_scene_light_desc ld;mt_scene_instances_desc instances;
  mt_scene_environment_desc environment;mt_scene_environment_settings env_settings;
  mt_camera_v4 camera;float *positions,*uv,*matrices;uint32_t *indices;unsigned char pixels[1024];
  mt_scene_mesh_id *meshes;mt_scene_material_id *materials;uint32_t mesh_count,material_count;
  double compilation_start,preparation_start,preparation_ms,compile_ms[64];unsigned compile_count,progress_seen;
} Bench;
static void event(const mt_engine_event *e,void *user){
  Bench *b=user;double t=now();
  if(e->kind==MT_ENGINE_EVENT_ERROR||e->kind==MT_ENGINE_EVENT_DEVICE_LOST){fprintf(stderr,"engine event: %s\n",e->message?e->message:"");return;}
  if(e->kind==MT_ENGINE_EVENT_COMPILATION){if(e->progress==0)b->compilation_start=t;else if(b->compile_count<64)b->compile_ms[b->compile_count++]=t-b->compilation_start;}
  if(e->kind==MT_ENGINE_EVENT_PROGRESS){if(e->progress==0){b->preparation_start=t;b->progress_seen=1;}else if(b->progress_seen)b->preparation_ms=t-b->preparation_start;}
}
static mt_engine_diagnostics_info diagnostics(Bench *b){mt_engine_diagnostics_info d={.struct_size=sizeof d};CHECK(mt_engine_diagnostics(b->engine,&d,error,sizeof error));return d;}
static void commit(Bench *b,const char *name,int repeat,uint32_t expected){
  uint32_t predicted,changed,status=0;double start=now();
  int camera_only=!strcmp(name,"engine_camera");
  if(getenv("MUTRACER_NATIVE_PROFILE"))fprintf(stderr,"{\"editCostProfile\":{\"case\":\"%s\",\"repeat\":%d}}\n",name,repeat);
  if(camera_only){predicted=MT_COMMIT_NONE;expected=MT_COMMIT_NONE;}else CHECK(mt_scene_pending_commit_kind(b->scene,&predicted,error,sizeof error));double prediction_ms=now()-start;
  mt_engine_diagnostics_info before=diagnostics(b);
  b->compile_count=0;b->progress_seen=0;b->preparation_ms=0;
  start=now();if(camera_only){CHECK(mt_engine_set_camera(b->engine,&b->camera,error,sizeof error));}else{CHECK(mt_engine_set_scene_object(b->engine,b->scene,error,sizeof error));}double set_ms=now()-start;
  start=now();CHECK(mt_engine_update(b->engine,&changed,error,sizeof error));double update_ms=now()-start,returned=now();
  if(!changed){fprintf(stderr,"no change in %s repeat %d\n",name,repeat);exit(1);}
  mt_render_snapshot r={.struct_size=sizeof r};mt_engine_diagnostics_info after=diagnostics(b);
  unsigned preparing=after.preparing,compiling=after.compiling,polls=0;double ready_ms=0;unsigned ready=0;
  for(;;){
    CHECK(mt_render_refine(b->render,&status,error,sizeof error));polls++;
    CHECK(mt_render_info(b->render,&r,error,sizeof error));after=diagnostics(b);
    preparing|=after.preparing;compiling|=after.compiling;
    if(!after.preparing&&!after.compiling&&!ready){ready=1;ready_ms=now()-returned;}
    if(r.status==MT_RENDER_ERROR){fprintf(stderr,"render error: %s\n",r.message);exit(1);}
    if((camera_only||after.scene_revision>before.scene_revision)&&r.samples>=1&&!after.preparing&&!after.compiling)break;
    if(now()-returned>300000){fprintf(stderr,"sample timeout: %s\n",name);exit(1);}mt_host_pause();
  }
  if(repeat>=0){
    printf("{\"case\":\"%s\",\"repeat\":%d,\"predicted\":%u,\"actual\":%u,\"documented\":%u,\"doc_mismatch\":%s,\"prediction_ms\":%.6f,\"set_ms\":%.6f,\"update_ms\":%.6f,\"first_sample_ms\":%.6f,\"ready_ms\":%.6f,\"preparation_event_ms\":%.6f,\"preparing_seen\":%u,\"compiling_seen\":%u,\"revision\":%" PRIu64 ",\"compilations_started\":%" PRIu64 ",\"compilations_completed\":%" PRIu64 ",\"cache_hits\":%" PRIu64 ",\"cached_pipelines\":%u,\"backend\":%u,\"polls\":%u,\"compile_event_ms\":[",name,repeat,predicted,camera_only?MT_COMMIT_NONE:r.last_commit,expected,(!camera_only&&expected!=r.last_commit&&after.compilations_started==before.compilations_started)?"true":"false",prediction_ms,set_ms,update_ms,now()-returned,ready_ms,b->preparation_ms,preparing,compiling,after.scene_revision,after.compilations_started-before.compilations_started,after.compilations_completed-before.compilations_completed,after.pipeline_cache_hits-before.pipeline_cache_hits,after.cached_pipelines,r.backend,polls);
    for(unsigned i=0;i<b->compile_count;i++)printf("%s%.6f",i?",":"",b->compile_ms[i]);puts("]}");fflush(stdout);
  }
}
static void material(Bench *b,uint32_t property,float x,float y,float z){CHECK(mt_scene_material_set_float(b->scene,b->material,property,x,y,z,error,sizeof error));}
static void build(Bench *b,uint32_t backend,uint32_t meshes,uint32_t materials,uint32_t lights,uint32_t grid,uint32_t instances,uint32_t width,uint32_t height){
  CHECK(mt_scene_create(&b->scene,error,sizeof error));
  uint32_t vertices=(grid+1)*(grid+1),index_count=grid*grid*6;
  b->positions=alloc(vertices*3,sizeof(float));b->uv=alloc(vertices*2,sizeof(float));b->indices=alloc(index_count,sizeof(uint32_t));
  for(uint32_t y=0;y<=grid;y++)for(uint32_t x=0;x<=grid;x++){uint32_t v=y*(grid+1)+x;b->positions[v*3]=(float)x/grid-.5f;b->positions[v*3+2]=(float)y/grid-.5f;b->uv[v*2]=(float)x/grid;b->uv[v*2+1]=(float)y/grid;}
  for(uint32_t y=0;y<grid;y++)for(uint32_t x=0;x<grid;x++){uint32_t v=y*(grid+1)+x,k=(y*grid+x)*6;uint32_t ids[]={v,v+grid+1,v+1,v+1,v+grid+1,v+grid+2};memcpy(b->indices+k,ids,sizeof ids);}
  CHECK(mt_scene_geometry_desc_default(&b->gd));b->gd.vertex_count=vertices;b->gd.index_count=index_count;b->gd.positions=b->positions;b->gd.indices=b->indices;b->gd.uv=b->uv;
  for(unsigned i=0;i<sizeof b->pixels;i++)b->pixels[i]=(i%4==3)?255:128;
  CHECK(mt_scene_texture_desc_default(&b->td));b->td.width=b->td.height=8;b->td.pixels=b->pixels;b->td.pixel_bytes=256;
  for(unsigned i=0;i<2;i++)CHECK(mt_scene_add_texture(b->scene,&b->td,&b->textures[i],error,sizeof error));
  CHECK(mt_scene_add_texture(b->scene,&b->td,&b->textures[3],error,sizeof error));
  float hdr[128];for(unsigned i=0;i<128;i++)hdr[i]=i%4==3?1:.1f;
  mt_scene_texture_desc hd;CHECK(mt_scene_texture_desc_default(&hd));hd.storage=MT_TEXTURE_STORAGE_RGBA32F;hd.width=8;hd.height=4;hd.pixels=hdr;hd.pixel_bytes=sizeof hdr;
  CHECK(mt_scene_add_texture(b->scene,&hd,&b->textures[2],error,sizeof error));
  mt_scene_material_id *m=alloc(materials,sizeof *m);b->materials=m;b->material_count=materials;b->meshes=alloc(meshes,sizeof *b->meshes);b->mesh_count=meshes;mt_scene_material_desc mat;CHECK(mt_scene_material_desc_default(&mat));
  for(uint32_t i=0;i<materials;i++){CHECK(mt_scene_add_material(b->scene,&mat,&m[i],error,sizeof error));if(i%2)CHECK(mt_scene_material_set_texture(b->scene,m[i],MT_MAT_MAP,b->textures[0],error,sizeof error));}
  b->material=m[0];CHECK(mt_scene_mesh_desc_default(&b->md));
  for(uint32_t i=0;i<meshes;i++){
    mt_scene_geometry_id g;CHECK(mt_scene_add_geometry(b->scene,&b->gd,&g,error,sizeof error));b->md.geometry=g;b->md.material=m[i%materials];b->md.world_matrix[12]=(float)(i%64)*1.1f;b->md.world_matrix[14]=(float)(i/64)*1.1f;
    mt_scene_mesh_id mesh;CHECK(mt_scene_add_mesh(b->scene,&b->md,&mesh,error,sizeof error));b->meshes[i]=mesh;if(i==0){b->geometry=g;b->mesh=mesh;}
  }
  b->md.geometry=b->geometry;b->md.material=b->material;mt_scene_identity(b->md.world_matrix);
  /* Keep the edited material off the large batch: emission must measure one
   * material edit without exhausting the emissive-light sampling texture. */
  b->md.material=m[materials-1];
  CHECK(mt_scene_instances_desc_default(&b->instances));b->instances.count=instances;
  if(instances){b->matrices=alloc((size_t)instances*16,sizeof(float));for(uint32_t i=0;i<instances;i++){mt_scene_identity(b->matrices+i*16);b->matrices[i*16+12]=(float)(i%512)*1.1f;b->matrices[i*16+14]=100+(float)(i/512)*1.1f;}b->instances.transforms=b->matrices;CHECK(mt_scene_add_instances(b->scene,&b->md,&b->instances,&b->batch,error,sizeof error));}
  b->md.material=b->material;
  CHECK(mt_scene_light_desc_default(&b->ld));for(uint32_t i=0;i<lights;i++){b->ld.type=i%4;b->ld.intensity=.1f;const float at[]={2,8,2},target[]={0,0,0};mt_scene_look_at(b->ld.world_matrix,at,target);mt_scene_light_id id;CHECK(mt_scene_add_light(b->scene,&b->ld,&id,error,sizeof error));if(!i)b->light=id;}
  b->ld.type=MT_LIGHT_TYPE_RECT;
  CHECK(mt_scene_environment_desc_default(&b->environment));b->environment.environment=b->textures[2];CHECK(mt_scene_set_environment(b->scene,&b->environment,error,sizeof error));CHECK(mt_scene_environment_settings_default(&b->env_settings));
  b->camera=mt_camera_v4_default();const float at[]={3,4,6},target[]={2,0,2};mt_scene_look_at(b->camera.world_matrix,at,target);CHECK(mt_scene_set_default_camera(b->scene,&b->camera,error,sizeof error));
  mt_engine_options eo;CHECK(mt_engine_options_default(&eo));eo.backend=backend;CHECK(mt_engine_create(&eo,&b->engine,error,sizeof error));CHECK(mt_engine_set_callback(b->engine,event,b,error,sizeof error));
  mt_render_options ro;CHECK(mt_render_options_default(&ro));ro.width=width;ro.height=height;ro.max_samples=1;ro.batch_samples=0;CHECK(mt_render_create(b->engine,&ro,&b->render,error,sizeof error));
  mt_engine_snapshot info={.struct_size=sizeof info};CHECK(mt_engine_info(b->engine,&info,error,sizeof error));
  printf("{\"metadata\":true,\"adapter\":\"%s\",\"requested_backend\":%u,\"hardware_ray_query\":%u,\"meshes\":%u,\"materials\":%u,\"lights\":%u,\"grid\":%u,\"triangles\":%" PRIu64 ",\"instances\":%u,\"width\":%u,\"height\":%u,\"abi\":%u}\n",info.adapter_name,backend,info.hardware_ray_query,meshes,materials,lights,grid,(uint64_t)meshes*grid*grid*2,instances,width,height,mt_abi_version());
}
typedef struct {const char *name;uint32_t property;float original[3],value[3];uint32_t expected;} Scalar;
#define P(name,p,old,v) {name,p,{old,0,0},{v,0,0},MT_COMMIT_INCREMENTAL}
static const Scalar scalars[]={
 {"base_color",2,{.8f,.8f,.8f},{.4f,.5f,.6f},2},P("roughness",7,.3f,.6f),P("metalness",4,0,.3f),P("transmission",10,0,.2f),P("ior",8,1.5f,1.6f),
 {"emission_color",34,{1,1,1},{.4f,.5f,.6f},2},P("emission_strength",35,0,.2f),P("coat",25,0,.3f),P("opacity",36,1,.8f),
 P("base_weight",1,1,.9f),P("diffuse_roughness",3,0,.2f),P("specular_weight",5,1,.7f),{"specular_color",6,{1,1,1},{.7f,.8f,.9f},2},P("anisotropy",9,0,.2f),
 {"transmission_color",11,{1,1,1},{.8f,.9f,.7f},2},P("transmission_depth",12,0,.2f),{"transmission_scatter",13,{0,0,0},{.1f,.2f,.3f},2},P("scatter_anisotropy",14,0,.2f),{"dispersion_scale",15,{0,0,0},{.2f,0,0},MT_COMMIT_FULL},P("dispersion_abbe",16,20,30),
 {"subsurface",17,{0,0,0},{.2f,0,0},MT_COMMIT_FULL},{"subsurface_color",18,{.8f,.8f,.8f},{.4f,.5f,.6f},2},P("subsurface_radius",19,1,.8f),{"radius_scale",20,{1,.5f,.25f},{.8f,.4f,.2f},2},P("subsurface_anisotropy",21,0,.2f),
 P("fuzz",22,0,.2f),{"fuzz_color",23,{1,1,1},{.4f,.5f,.6f},2},P("fuzz_roughness",24,.5f,.7f),{"coat_color",26,{1,1,1},{.4f,.5f,.6f},2},P("coat_roughness",27,0,.2f),P("coat_anisotropy",28,0,.2f),P("coat_ior",29,1.6f,1.7f),P("coat_darkening",30,0,.2f),
 P("thin_film",31,0,.2f),P("film_thickness",32,.5f,.6f),P("film_ior",33,1.4f,1.5f),P("anisotropy_rotation",71,0,.2f),P("coat_rotation",72,0,.2f)
};
static const char *edits[]={"camera","mesh_transform","instance_matrices","vertices","thin_walls","texture_add","texture_remove","texture_replace","texture_pixels","uv","indices","mesh_add","mesh_remove","visibility_remove_add","light_add","light_remove","light_modify","environment_intensity","environment_rotation","environment_add","environment_remove","batch","engine_camera",
  "batch_transforms_16","batch_transforms_64","batch_transforms_256","batch_materials_16","batch_materials_64","batch_materials_256","first_transform","first_material","instances_64","instances_1024","instances_16384","instances_half","visibility","visibility_delete","texture_larger","mesh_add_headroom","new_geometry_add"};
/* Edits N distinct meshes (world matrices) or N distinct materials in one commit. */
static uint32_t batch_size(unsigned c){return c>=23&&c<=28?(const uint32_t[]){16,64,256}[(c-23)%3]:0;}
static void edit(Bench *b,unsigned c,int on){
  switch(c){
  case 35:CHECK(mt_scene_set_mesh_visible(b->scene,b->mesh,(uint32_t)!on,error,sizeof error));break;
  case 36:if(on)CHECK(mt_scene_remove_mesh(b->scene,b->mesh,error,sizeof error));else CHECK(mt_scene_add_mesh(b->scene,&b->md,&b->mesh,error,sizeof error));break;
  case 37:{mt_scene_texture_desc changed=b->td;if(on){changed.width=changed.height=16;changed.pixel_bytes=sizeof b->pixels;}CHECK(mt_scene_set_texture(b->scene,b->textures[3],&changed,error,sizeof error));CHECK(mt_scene_material_set_texture(b->scene,b->material,MT_MAT_MAP,b->textures[on?3:0],error,sizeof error));break;}
  case 38:if(on)CHECK(mt_scene_add_mesh(b->scene,&b->md,&b->extra,error,sizeof error));else CHECK(mt_scene_remove_mesh(b->scene,b->extra,error,sizeof error));break;
  case 39:if(on){CHECK(mt_scene_add_geometry(b->scene,&b->gd,&b->extra_geometry,error,sizeof error));mt_scene_mesh_desc desc=b->md;desc.geometry=b->extra_geometry;CHECK(mt_scene_add_mesh(b->scene,&desc,&b->extra,error,sizeof error));}else{CHECK(mt_scene_remove_mesh(b->scene,b->extra,error,sizeof error));CHECK(mt_scene_remove_geometry(b->scene,b->extra_geometry,error,sizeof error));}break;
  case 0:b->camera.world_matrix[12]+=on?.01f:-.01f;CHECK(mt_scene_set_default_camera(b->scene,&b->camera,error,sizeof error));break;
  case 1:b->md.world_matrix[12]=on?.01f:0;CHECK(mt_scene_set_mesh_transform(b->scene,b->mesh,b->md.world_matrix,error,sizeof error));break;
  case 2:for(uint32_t i=0;i<b->instances.count;i++)b->matrices[i*16+12]+=on?.01f:-.01f;CHECK(mt_scene_set_instances(b->scene,b->batch,&b->instances,error,sizeof error));break;
  case 3:b->positions[1]=on?.01f:0;CHECK(mt_scene_set_geometry(b->scene,b->geometry,&b->gd,error,sizeof error));break;
  case 4:CHECK(mt_scene_material_set_uint(b->scene,b->material,MT_MAT_THIN_WALLED,(uint32_t)on,error,sizeof error));break;
  case 5:case 6:case 7:{mt_scene_texture_id id=c==5?(on?b->textures[0]:0):c==6?(on?0:b->textures[0]):b->textures[on?1:0];CHECK(mt_scene_material_set_texture(b->scene,b->material,MT_MAT_MAP,id,error,sizeof error));break;}
  case 8:b->pixels[0]=on?64:128;CHECK(mt_scene_set_texture(b->scene,b->textures[0],&b->td,error,sizeof error));break;
  case 9:b->uv[0]=on?.1f:0;CHECK(mt_scene_set_geometry(b->scene,b->geometry,&b->gd,error,sizeof error));break;
  case 10:b->indices[0]=on?1:0;CHECK(mt_scene_set_geometry(b->scene,b->geometry,&b->gd,error,sizeof error));break;
  case 11:if(on)CHECK(mt_scene_add_mesh(b->scene,&b->md,&b->extra,error,sizeof error));else CHECK(mt_scene_remove_mesh(b->scene,b->extra,error,sizeof error));break;
  case 12:if(on)CHECK(mt_scene_remove_mesh(b->scene,b->mesh,error,sizeof error));else CHECK(mt_scene_add_mesh(b->scene,&b->md,&b->mesh,error,sizeof error));break;
  case 13:CHECK(mt_scene_remove_mesh(b->scene,b->mesh,error,sizeof error));CHECK(mt_scene_add_mesh(b->scene,&b->md,&b->mesh,error,sizeof error));b->md.world_matrix[12]=on?.01f:0;CHECK(mt_scene_set_mesh_transform(b->scene,b->mesh,b->md.world_matrix,error,sizeof error));break;
  case 14:if(on)CHECK(mt_scene_add_light(b->scene,&b->ld,&b->extra_light,error,sizeof error));else CHECK(mt_scene_remove_light(b->scene,b->extra_light,error,sizeof error));break;
  case 15:if(on)CHECK(mt_scene_remove_light(b->scene,b->light,error,sizeof error));else CHECK(mt_scene_add_light(b->scene,&b->ld,&b->light,error,sizeof error));break;
  case 16:b->ld.intensity=on?.2f:.1f;CHECK(mt_scene_set_light(b->scene,b->light,&b->ld,error,sizeof error));break;
  case 17:case 18:if(c==17)b->env_settings.intensity=on?.8f:1;else b->env_settings.rotation=on?.1f:0;CHECK(mt_scene_set_environment_settings(b->scene,&b->env_settings,error,sizeof error));break;
  case 19:case 20:b->environment.environment=(on==(c==19))?b->textures[2]:0;CHECK(mt_scene_set_environment(b->scene,&b->environment,error,sizeof error));break;
  case 22:b->camera.world_matrix[12]+=on?.01f:-.01f;break;
  case 23:case 24:case 25:for(uint32_t i=0;i<batch_size(c);i++){float w[16];mt_scene_identity(w);w[12]=(float)(i%64)*1.1f+(on?.01f:0);w[14]=(float)(i/64)*1.1f;CHECK(mt_scene_set_mesh_transform(b->scene,b->meshes[i],w,error,sizeof error));}break;
  case 26:case 27:case 28:for(uint32_t i=0;i<batch_size(c);i++)CHECK(mt_scene_material_set_float(b->scene,b->materials[i],MT_MAT_SPECULAR_ROUGHNESS,on?.6f:.3f,0,0,error,sizeof error));break;
  case 29:edit(b,1,on);break;
  case 31:case 32:case 33:case 34:{uint32_t n=c==34?b->instances.count/2:(const uint32_t[]){64,1024,16384}[c-31];for(uint32_t i=0;i<n;i++)b->matrices[i*16+12]+=on?.01f:-.01f;CHECK(mt_scene_set_instances(b->scene,b->batch,&b->instances,error,sizeof error));break;}
  case 30:CHECK(mt_scene_material_set_float(b->scene,b->material,MT_MAT_BASE_COLOR,on?.4f:.8f,on?.5f:.8f,on?.6f:.8f,error,sizeof error));break;
  case 21:edit(b,0,on);edit(b,1,on);material(b,MT_MAT_SPECULAR_ROUGHNESS,on?.6f:.3f,0,0);edit(b,16,on);edit(b,17,on);break;
  }
}
int main(int argc,char **argv){
  if(argc<10){fprintf(stderr,"usage: %s backend meshes materials lights grid instances repeats width height [case]\n",argv[0]);return 1;}
  uint32_t backend=number(argv[1],0,1),meshes=number(argv[2],2,65536),materials=number(argv[3],2,65536),lights=number(argv[4],4,63),grid=number(argv[5],1,1000),instances=number(argv[6],0,1000000),repeats=number(argv[7],5,100),width=number(argv[8],1,8192),height=number(argv[9],1,8192);
  if(mt_abi_version()!=MT_ABI_VERSION){fprintf(stderr,"SDK ABI mismatch\n");return 1;}
  if(getenv("MUTRACER_NATIVE_PROFILE"))CHECK(mt_set_log_callback(log_message,NULL));
  const char *filter=argc>10?argv[10]:NULL;Bench b={0};build(&b,backend,meshes,materials,lights,grid,instances,width,height);commit(&b,"initial",0,1);
  /* Two features absent from the baseline, then its original variant. Repeat in
   * one engine to distinguish process-local pipeline reuse from system caching. */
  for(uint32_t r=0;r<repeats+1;r++){
    material(&b,MT_MAT_COAT_WEIGHT,.3f,0,0);commit(&b,"variant_coat",(int)r,1);
    material(&b,MT_MAT_SUBSURFACE_WEIGHT,.2f,0,0);commit(&b,"variant_coat_subsurface",(int)r,1);
    material(&b,MT_MAT_COAT_WEIGHT,0,0,0);material(&b,MT_MAT_SUBSURFACE_WEIGHT,0,0,0);commit(&b,"variant_return",(int)r,1);
  }
  for(unsigned c=0;c<sizeof scalars/sizeof scalars[0];c++){
    const Scalar *s=&scalars[c];if(!selected(filter,s->name))continue;
    for(uint32_t r=0;r<repeats+1;r++){material(&b,s->property,s->value[0],s->value[1],s->value[2]);commit(&b,s->name,(int)r,s->expected);material(&b,s->property,s->original[0],s->original[1],s->original[2]);commit(&b,"reset",-1,s->expected);}
  }
  for(unsigned c=0;c<sizeof edits/sizeof edits[0];c++){
    if(!selected(filter,edits[c])||(c==2&&!instances))continue;
    if((c>=23&&c<=25&&batch_size(c)>meshes)||(c>=26&&c<=28&&batch_size(c)>materials))continue;
    if((c>=31&&c<=33&&(const uint32_t[]){64,1024,16384}[c-31]>instances)||(c==34&&instances<2))continue;
    if(c==29||c==30){
      /* Each repetition first commits a full preparation (unmeasured), so the
       * measured edit is the first incremental commit after it. */
      for(uint32_t r=0;r<repeats+1;r++){edit(&b,11,1);commit(&b,"setup",-1,1);edit(&b,c,1);commit(&b,edits[c],(int)r,2);edit(&b,c,0);commit(&b,"reset",-1,2);edit(&b,11,0);commit(&b,"cleanup",-1,1);}
      continue;
    }
    /* The inverse state of removal/replacement/add-environment has to exist. */
    if(c==6||c==7){CHECK(mt_scene_material_set_texture(b.scene,b.material,MT_MAT_MAP,b.textures[0],error,sizeof error));commit(&b,"setup",-1,1);}
    if(c==19){b.environment.environment=0;CHECK(mt_scene_set_environment(b.scene,&b.environment,error,sizeof error));commit(&b,"setup",-1,1);}
    if(c==38){CHECK(mt_scene_remove_mesh(b.scene,b.meshes[b.mesh_count-1],error,sizeof error));commit(&b,"setup",-1,2);}
    /* Full above max(64, half of the batch) changed instances. */
    uint32_t limit=instances/2>64?instances/2:64;
    uint32_t expected=((c==2&&instances>limit)||(c==32&&1024>limit)||(c==33&&16384>limit)||(c>=9&&c<=10)||c==19||c==20||c==36||c==37)?1:2;
    for(uint32_t r=0;r<repeats+1;r++){edit(&b,c,1);commit(&b,edits[c],(int)r,expected);edit(&b,c,0);commit(&b,c==22?"engine_camera":"reset",-1,expected);}
    if(c==6||c==7){CHECK(mt_scene_material_set_texture(b.scene,b.material,MT_MAT_MAP,0,error,sizeof error));commit(&b,"cleanup",-1,1);}
    if(c==19){b.environment.environment=b.textures[2];CHECK(mt_scene_set_environment(b.scene,&b.environment,error,sizeof error));commit(&b,"cleanup",-1,1);}
  }
  if(selected(filter,"scene_unchanged"))for(uint32_t r=0;r<=repeats;r++){
    if(getenv("MUTRACER_NATIVE_PROFILE"))fprintf(stderr,"{\"editCostProfile\":{\"case\":\"scene_unchanged\",\"repeat\":%u}}\n",r);
    double start=now();CHECK(mt_engine_set_scene_object(b.engine,b.scene,error,sizeof error));double elapsed=now()-start;
    printf("{\"case\":\"scene_unchanged\",\"repeat\":%u,\"predicted\":0,\"actual\":0,\"doc_mismatch\":false,\"prediction_ms\":0,\"set_ms\":%.6f,\"update_ms\":0,\"first_sample_ms\":0,\"ready_ms\":0,\"preparation_event_ms\":0,\"compile_event_ms\":[],\"cache_hits\":0}\n",r,elapsed);
  }
  CHECK(mt_engine_destroy(b.engine,error,sizeof error));CHECK(mt_scene_destroy(b.scene,error,sizeof error));free(b.positions);free(b.uv);free(b.indices);free(b.matrices);free(b.meshes);free(b.materials);return 0;
}
