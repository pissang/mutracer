#include "mutracer-context.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "host-time.h"
_Static_assert(sizeof(mt_render_settings)==64,"settings ABI");
static char error[4096];
static unsigned checks=0;
#define REQUIRE(x) do {checks++;if(!(x)){fprintf(stderr,"settings check %u, line %d: %s\n",checks,__LINE__,#x);return 1;}} while(0)
#define OK(x) do {int status=(x);checks++;if(status){fprintf(stderr,"settings check %u, line %d: %s\n",checks,__LINE__,error);return 1;}} while(0)
#define FAILS(status,x) REQUIRE((x)==(status))
static int backend_is(mt_context context,uint32_t expected) {
 uint32_t actual=99;char reason[512];
 return mt_context_backend(context,&actual,reason,sizeof(reason),error,sizeof(error)) || actual!=expected;
}
static unsigned char *load(const char *path,size_t *size) {
 FILE *f=fopen(path,"rb");if(!f||fseek(f,0,SEEK_END))return NULL;long n=ftell(f);if(n<0||fseek(f,0,SEEK_SET))return NULL;
 unsigned char *bytes=malloc(n?(size_t)n:1);if(!bytes||fread(bytes,1,(size_t)n,f)!=(size_t)n)return NULL;
 fclose(f);*size=(size_t)n;return bytes;
}
static int pixels(mt_context context,unsigned kind,unsigned char *bytes,size_t size) {
 size_t written=0;return mt_context_read_pixels(context,kind,bytes,size,&written,error,sizeof(error))||written!=size;
}
int main(int argc,char **argv) {
 if(argc!=4)return 2;
 size_t length=0;unsigned char *input=load(argv[1],&length);if(!input||length<128)return 2;
 uint32_t *words=(uint32_t*)input;size_t size=(size_t)words[2]*words[3]*16;
 unsigned backend=(unsigned)strtoul(argv[3],NULL,10);if(backend>1)return 2;
 unsigned char *reference=malloc(size*3),*image=malloc(size),*default_hdr=malloc(size);if(!reference||!image||!default_hdr)return 2;
 mt_render_settings settings;FAILS(MT_ERROR_INVALID_ARGUMENT,mt_render_settings_default(NULL));
 OK(mt_render_settings_default(&settings));REQUIRE(settings.struct_size==sizeof(settings)&&settings.seed==12345&&settings.bounces==6&&settings.direct_light_candidates==2&&settings.bevel_samples==8);
 mt_context context=0;OK(mt_context_create_with_backend(backend,&context,error,sizeof(error)));
 OK(mt_context_commit(context,input,length,error,sizeof(error)));OK(backend_is(context,backend));
 uint32_t actual=99;char reason[512];OK(mt_context_backend(context,&actual,reason,sizeof(reason),error,sizeof(error)));REQUIRE(actual==backend);
 OK(mt_context_render(context,8,error,sizeof(error)));
 for(unsigned kind=0;kind<3;kind++)OK(pixels(context,kind,reference+kind*size,size));
 memcpy(default_hdr,reference,size);
 if(backend==0) {
  /* Out-of-range counts clamp to 20 bounces, 16 candidates and 32 bevel samples. */
  mt_render_settings limits=settings;limits.bounces=20;limits.direct_light_candidates=16;limits.bevel_samples=32;
  OK(mt_context_commit_with_settings(context,input,length,&limits,error,sizeof(error)));OK(mt_context_render(context,8,error,sizeof(error)));
  for(unsigned kind=0;kind<3;kind++)OK(pixels(context,kind,reference+kind*size,size));
  limits.bounces=limits.direct_light_candidates=limits.bevel_samples=99;
  OK(mt_context_commit_with_settings(context,input,length,&limits,error,sizeof(error)));OK(backend_is(context,backend));OK(mt_context_render(context,8,error,sizeof(error)));
  for(unsigned kind=0;kind<3;kind++){OK(pixels(context,kind,image,size));REQUIRE(memcmp(image,reference+kind*size,size)==0);}
 }
 for(unsigned pattern=0;pattern<3;pattern++) {
  OK(mt_render_settings_default(&settings));settings.seed=67890;settings.sampling_pattern=pattern; /* mt_sampling_pattern */settings.max_samples=65;
  if(pattern) {
   settings.bounces=3;settings.direct_light_candidates=4;settings.bevel_samples=4;
   settings.clamping=.8;settings.transmissive_output_alpha_min=.4;settings.sample_sequence_offset=3;
  }
  OK(mt_context_commit_with_settings(context,input,length,&settings,error,sizeof(error)));OK(backend_is(context,backend));
  OK(mt_context_backend(context,&actual,reason,sizeof(reason),error,sizeof(error)));REQUIRE(actual==backend);
  OK(mt_context_render(context,3,error,sizeof(error)));OK(mt_context_render(context,5,error,sizeof(error)));
  for(unsigned kind=0;kind<3;kind++) {
   OK(pixels(context,kind,reference+kind*size,size));
   if(backend==0&&pattern==0&&kind==0)REQUIRE(memcmp(default_hdr,reference,size)!=0);
   const float *f=(const float*)(reference+kind*size);for(size_t i=0;i<size/4;i++)REQUIRE(isfinite(f[i]));
   char path[4096];REQUIRE(snprintf(path,sizeof(path),"%s/pattern-%u-%u.rgba32f",argv[2],pattern,kind)<(int)sizeof(path));
   FILE *out=fopen(path,"wb");REQUIRE(out&&fwrite(reference+kind*size,1,size,out)==size);fclose(out);
  }
  mt_render_settings bad=settings;bad.sampling_pattern=3;FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_commit_with_settings(context,input,length,&bad,error,sizeof(error)));
  bad=settings;bad.struct_size--;FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_commit_with_settings(context,input,length,&bad,error,sizeof(error)));
  bad=settings;bad.clamping=NAN;FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_commit_with_settings(context,input,length,&bad,error,sizeof(error)));
  FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_commit_with_settings(context,input,length,NULL,error,sizeof(error)));
  for(unsigned kind=0;kind<3;kind++){OK(pixels(context,kind,image,size));REQUIRE(memcmp(image,reference+kind*size,size)==0);}
  OK(mt_context_reset(context,error,sizeof(error)));
  mt_render_job job=0;OK(mt_context_submit(context,8,&job,error,sizeof(error)));
  mt_job_snapshot info={.struct_size=sizeof(info)};unsigned iteration=0;
  for(;iteration<60000;iteration++) {
   OK(mt_job_poll(job,3,error,sizeof(error)));OK(mt_job_info(job,&info,error,sizeof(error)));
   if(info.state==MT_JOB_COMPLETE)break;REQUIRE(info.state<=MT_JOB_COMPLETE);mt_host_pause();
  }
  REQUIRE(iteration<60000&&info.completed_samples==8);
  for(unsigned kind=0;kind<3;kind++){OK(pixels(context,kind,image,size));REQUIRE(memcmp(image,reference+kind*size,size)==0);}
  /* Publishing a full commit cancels/expires an unfinished queued job. */
  OK(mt_context_submit(context,1,&job,error,sizeof(error)));
  OK(mt_context_commit_with_settings(context,input,length,&settings,error,sizeof(error)));OK(backend_is(context,backend));
  FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(job,&info,error,sizeof(error)));
 }
 OK(mt_context_destroy(context,error,sizeof(error)));
 free(default_hdr);free(reference);free(image);free(input);printf("PASS %u settings checks\n",checks);return 0;
}
