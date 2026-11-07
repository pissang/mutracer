/* A real native caller constructs raw geometry and editable scene descriptors.
 * No capture files, JavaScript-generated resources, or embedded GPU shaders.
 * Record fields use the MT_* word offsets from mutracer-layout.h. */
#include "mutracer-debug.h"
#include "mutracer-material-properties.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t words[65536];
static uint32_t used = MT_HEADER_WORDS;
static uint32_t reserve(uint32_t count) {
  uint32_t off=used; if (count>65536-used) exit(2); used+=count; return off;
}
static void value(uint32_t off,double x) {float f=(float)x;memcpy(words+off,&f,4);}
static void vector(uint32_t off,double x,double y,double z) {value(off,x);value(off+1,y);value(off+2,z);}
static void matrix(uint32_t off,double scale,double x,double y,double z) {
  value(off,scale);value(off+5,scale);value(off+10,scale);value(off+15,1);vector(off+12,x,y,z);
}
/* Writes extension entry `index` of a table at `base` and returns its X word. */
static uint32_t extension(uint32_t base,uint32_t index,uint32_t id) {
  uint32_t entry=base+index*MT_EXTENSION_WORDS;words[entry+MT_EXTENSION_ID]=id;return entry+MT_EXTENSION_X;
}
static void camera(uint32_t off) {
  const double eye[3]={0,2.4,6},target[3]={0,.4,-.3};
  double z[3],x[3],y[3],n=0;
  for(int k=0;k<3;k++){z[k]=eye[k]-target[k];n+=z[k]*z[k];} n=sqrt(n);
  for(int k=0;k<3;k++)z[k]/=n;
  x[0]=z[2];x[1]=0;x[2]=-z[0];n=sqrt(x[0]*x[0]+x[2]*x[2]);
  for(int k=0;k<3;k++)x[k]/=n;
  y[0]=z[1]*x[2]-z[2]*x[1];y[1]=z[2]*x[0]-z[0]*x[2];y[2]=z[0]*x[1]-z[1]*x[0];
  for(int k=0;k<3;k++){value(off+k,x[k]);value(off+4+k,y[k]);value(off+8+k,z[k]);value(off+12+k,eye[k]);}
  value(off+15,1);
}
static size_t make_scene(const char *variant) {
  memset(words,0,sizeof(words));used=MT_HEADER_WORDS;
  int floating=!strcmp(variant,"float-textures"),textured=!strcmp(variant,"textures")||floating,affine=!strcmp(variant,"transforms"),emissive=!strcmp(variant,"emissive");
  int displacement_or_photometric=!strncmp(variant,"v3-",3),advanced=!strncmp(variant,"v2-",3)||displacement_or_photometric;
  uint32_t light_count=!strcmp(variant,"v3-ies-shared")?2:!strcmp(variant,"lights-1024")?1024:1;
  uint32_t texture_count=advanced?4:(uint32_t)textured;
  uint32_t geos=reserve(2*MT_GEOMETRY_WORDS),meshes=reserve(4*MT_MESH_WORDS),materials=reserve(4*MT_MATERIAL_WORDS);
  uint32_t lights=reserve(light_count*MT_LIGHT_WORDS),textures=reserve(texture_count*MT_TEXTURE_WORDS),cam=reserve(MT_CAMERA_WORDS);
  words[MT_HEADER_VERSION]=MT_VERSION_SCENE;words[MT_HEADER_WIDTH]=480;words[MT_HEADER_HEIGHT]=320;
  words[MT_HEADER_GEOMETRY_COUNT]=2;words[MT_HEADER_MESH_COUNT]=4;words[MT_HEADER_MATERIAL_COUNT]=4;
  words[MT_HEADER_LIGHT_COUNT]=light_count;words[MT_HEADER_TEXTURE_COUNT]=texture_count;
  words[MT_HEADER_GEOMETRY_OFFSET]=geos;words[MT_HEADER_MESH_OFFSET]=meshes;words[MT_HEADER_MATERIAL_OFFSET]=materials;
  words[MT_HEADER_LIGHT_OFFSET]=lights;words[MT_HEADER_TEXTURE_OFFSET]=textures;words[MT_HEADER_CAMERA_OFFSET]=cam;
  vector(MT_HEADER_BACKGROUND_COLOR,.055,.075,.11);value(MT_HEADER_BACKGROUND_COLOR+3,1);
  const uint32_t phi=32,theta=20,vc=(phi+1)*(theta+1),ic=phi*theta*6;
  /* Geometry 0: floor quad. */
  uint32_t pos=reserve(12),idx=reserve(6),norm=reserve(12),uv=reserve(8);
  words[geos+MT_GEOMETRY_VERTEX_COUNT]=4;words[geos+MT_GEOMETRY_INDEX_COUNT]=6;
  words[geos+MT_GEOMETRY_POSITION]=pos;words[geos+MT_GEOMETRY_INDICES]=idx;words[geos+MT_GEOMETRY_NORMAL]=norm;words[geos+MT_GEOMETRY_UV]=uv;
  for(uint32_t y=0;y<2;y++)for(uint32_t x=0;x<2;x++){uint32_t v=y*2+x;vector(pos+v*3,2*(double)y-1,0,2*(double)x-1);vector(norm+v*3,0,1,0);value(uv+v*2,x);value(uv+v*2+1,y);}
  const uint32_t floor_indices[]={0,1,2,2,1,3};memcpy(words+idx,floor_indices,sizeof(floor_indices));
  /* Geometry 1: UV sphere. */
  pos=reserve(vc*3);idx=reserve(ic);norm=reserve(vc*3);uv=reserve(vc*2);
  uint32_t g=geos+MT_GEOMETRY_WORDS;
  words[g+MT_GEOMETRY_VERTEX_COUNT]=vc;words[g+MT_GEOMETRY_INDEX_COUNT]=ic;
  words[g+MT_GEOMETRY_POSITION]=pos;words[g+MT_GEOMETRY_INDICES]=idx;words[g+MT_GEOMETRY_NORMAL]=norm;words[g+MT_GEOMETRY_UV]=uv;
  const double pi=acos(-1.0);
  for(uint32_t j=0;j<=theta;j++)for(uint32_t i=0;i<=phi;i++){
    uint32_t v=j*(phi+1)+i;double u=(double)i/phi,t=(double)j/theta;
    double x=-cos(u*pi*2)*sin(t*pi),y=cos(t*pi),z=sin(u*pi*2)*sin(t*pi);
    vector(pos+v*3,x,y,z);vector(norm+v*3,x,y,z);value(uv+v*2,u);value(uv+v*2+1,t);
  }
  uint32_t n=0;
  for(uint32_t j=0;j<theta;j++)for(uint32_t i=0;i<phi;i++){
    uint32_t a=j*(phi+1)+i+1,b=a-1,d=(j+1)*(phi+1)+i+1,c=d-1;
    words[idx+n++]=a;words[idx+n++]=b;words[idx+n++]=d;words[idx+n++]=b;words[idx+n++]=c;words[idx+n++]=d;
  }
  /* Mesh i uses material i: a floor and three spheres. */
  const double colors[4][3]={{.55,.57,.6},{.8,.08,.04},{.95,.7,.25},{.85,.95,1}};
  for(uint32_t i=0;i<4;i++){
    uint32_t m=materials+i*MT_MATERIAL_WORDS;
    vector(m+MT_MATERIAL_BASE_COLOR,colors[i][0],colors[i][1],colors[i][2]);value(m+MT_MATERIAL_ROUGHNESS,i==0?.65:i==1?.35:i==2?.2:.05);
    value(m+MT_MATERIAL_METALNESS,i==2?1:0);value(m+MT_MATERIAL_TRANSMISSION,i==3?1:0);value(m+MT_MATERIAL_IOR,1.5);
    vector(m+MT_MATERIAL_EMISSION_COLOR,1,1,1);value(m+MT_MATERIAL_OPACITY,1);
    for(uint32_t k=MT_MATERIAL_MAP;k<=MT_MATERIAL_EMISSIVE_MAP;k++)words[m+k]=MT_NO_TEXTURE;
    uint32_t mo=meshes+i*MT_MESH_WORDS,world=mo+MT_MESH_TRANSFORM;
    words[mo+MT_MESH_GEOMETRY]=i?1:0;words[mo+MT_MESH_MATERIAL]=i;matrix(world,i?.55:5,i?((double)i-2)*1.2:0,i?.55:0,0);
    if(affine&&i){value(world,i==2?-.6:.6);value(world+5,.85);value(world+10,.38);value(world+4,.12);}
    if(emissive&&i==1){value(m+MT_MATERIAL_EMISSION_LUMINANCE,2);value(m+MT_MATERIAL_COAT_WEIGHT,.7);value(m+MT_MATERIAL_COAT_ROUGHNESS,.25);}
  }
  if(textured){
    uint32_t pixels=reserve(floating?64:16);
    words[textures+MT_TEXTURE_WIDTH]=4;words[textures+MT_TEXTURE_HEIGHT]=4;words[textures+MT_TEXTURE_PIXELS]=pixels;
    words[textures+MT_TEXTURE_STORAGE]=floating?MT_TEXTURE_STORAGE_RGBA32F:MT_TEXTURE_STORAGE_RGBA8_SRGB;value(textures+MT_TEXTURE_UV_SCALE,3);value(textures+MT_TEXTURE_UV_SCALE+1,3);
    for(uint32_t i=0;i<16;i++){if(floating){vector(pixels+i*4,(i%4+i/4)%2?2:.1,.3,.7);value(pixels+i*4+3,1);}else words[pixels+i]=((i%4+i/4)%2)?0xff5080e0u:0xffe0d090u;}
    words[materials+MT_MATERIAL_MAP]=0;
    value(materials+MT_MATERIAL_WORDS+MT_MATERIAL_COAT_WEIGHT,.7);value(materials+MT_MATERIAL_WORDS+MT_MATERIAL_COAT_ROUGHNESS,.2);
  }
  words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_RECT;vector(lights+MT_LIGHT_COLOR,1,.9,.78);value(lights+MT_LIGHT_INTENSITY,7);
  value(lights+MT_LIGHT_SIZE,2.5);value(lights+MT_LIGHT_HEIGHT_OR_INNER,2.5);value(lights+MT_LIGHT_SPREAD_OR_OUTER,1);
  uint32_t lm=lights+MT_LIGHT_TRANSFORM;matrix(lm,1,-1.5,3,1.5);value(lm+5,cos(-pi/2));value(lm+6,sin(-pi/2));value(lm+9,-sin(-pi/2));value(lm+10,cos(-pi/2));
  if(!strcmp(variant,"sphere-light")){words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_SPHERE;value(lights+MT_LIGHT_SIZE,.35);value(lights+MT_LIGHT_INTENSITY,30);}
  if(!strcmp(variant,"directional-light")){words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_DIRECTIONAL;value(lights+MT_LIGHT_INTENSITY,3);}
  if(!strcmp(variant,"spot-light")){
    words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_SPOT;value(lights+MT_LIGHT_SIZE,.2);value(lights+MT_LIGHT_HEIGHT_OR_INNER,20);
    value(lights+MT_LIGHT_SPREAD_OR_OUTER,35);value(lights+MT_LIGHT_INTENSITY,200);
  }
  if(!strcmp(variant,"disk-light")){
    words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_DISK;value(lights+MT_LIGHT_RADIUS,.75);value(lights+MT_LIGHT_INTENSITY,3);
    words[lights+MT_LIGHT_NORMALIZE]=1;
  }
  if(!strcmp(variant,"cylinder-light")){
    words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_CYLINDER;value(lights+MT_LIGHT_RADIUS,.25);value(lights+MT_LIGHT_LENGTH,1.5);
    value(lights+MT_LIGHT_INTENSITY,6);words[lights+MT_LIGHT_NORMALIZE]=1;words[lights+MT_LIGHT_TREAT_AS_LINE]=1;
  }
  if(!strcmp(variant,"lights-1024")){
    for(uint32_t i=1;i<light_count;i++){
      uint32_t at=lights+i*MT_LIGHT_WORDS;memcpy(words+at,words+lights,MT_LIGHT_WORDS*MT_WORD_BYTES);
      value(at+MT_LIGHT_TRANSFORM+12,(double)(i%16)*.25);
    }
  }
  if(!strcmp(variant,"alpha"))value(materials+MT_MATERIAL_WORDS+MT_MATERIAL_OPACITY,.4);
  words[cam+MT_CAMERA_PROJECTION]=!strcmp(variant,"orthographic")?MT_CAMERA_PROJECTION_ORTHOGRAPHIC:MT_CAMERA_PROJECTION_PERSPECTIVE;
  value(cam+MT_CAMERA_FOV,40);value(cam+MT_CAMERA_NEAR,.1);value(cam+MT_CAMERA_FAR,100);
  value(cam+MT_CAMERA_LEFT,-2.6);value(cam+MT_CAMERA_RIGHT,2.6);value(cam+MT_CAMERA_BOTTOM,-1.75);value(cam+MT_CAMERA_TOP,1.75);
  value(cam+MT_CAMERA_ZOOM,1);value(cam+MT_CAMERA_FOCUS_DISTANCE,10);value(cam+MT_CAMERA_SENSOR_HEIGHT,24);value(cam+MT_CAMERA_METERS_PER_UNIT,1);
  camera(cam+MT_CAMERA_TRANSFORM);
  if(!strcmp(variant,"missing-normals")){words[geos+MT_GEOMETRY_NORMAL]=0;words[geos+MT_GEOMETRY_WORDS+MT_GEOMETRY_NORMAL]=0;}
  if(advanced){
    for(uint32_t t=0;t<4;t++){
      uint32_t o=textures+t*MT_TEXTURE_WORDS,w=t==0?32:4,h=t==0?16:4,pixels=reserve(w*h*4);
      words[o+MT_TEXTURE_WIDTH]=w;words[o+MT_TEXTURE_HEIGHT]=h;words[o+MT_TEXTURE_STORAGE]=MT_TEXTURE_STORAGE_RGBA32F;words[o+MT_TEXTURE_PIXELS]=pixels;
      value(o+MT_TEXTURE_UV_SCALE,1);value(o+MT_TEXTURE_UV_SCALE+1,1);
      for(uint32_t y=0;y<h;y++)for(uint32_t x=0;x<w;x++){
        uint32_t k=pixels+(y*w+x)*4; double hot=(x>6&&x<10&&y>2&&y<6)?8:.1;
        if(t==0)vector(k,hot,hot*.75,hot*.4);
        else if(t==1)vector(k,((x+y)%2)?.2:1,((x+y)%2)?.25:.75,.85);
        else if(t==2)vector(k,.5+.1*(x%2),.5,1);
        else vector(k,1,.25,.7);
        value(k+3,(x+y)%2?.35:1);
      }
    }
    /* Map references are texture index plus one. */
    words[MT_HEADER_ENVIRONMENT_TEXTURE]=1;
    if(!strcmp(variant,"v2-background"))words[MT_HEADER_BACKGROUND_TEXTURE]=2;
    if(!strcmp(variant,"v2-hidden-background"))words[MT_HEADER_QUALITY_FLAGS]=MT_QUALITY_HIDE_BACKGROUND;
    if(!strcmp(variant,"v2-environment-only"))words[MT_HEADER_LIGHT_COUNT]=0;
    /* Material extensions use explicit wire IDs, including deliberate default
       overrides and values that enable shader variants absent in the base. */
    uint32_t m=materials+MT_MATERIAL_WORDS,e=reserve(12*MT_EXTENSION_WORDS);
    words[m+MT_MATERIAL_EXTENSION_COUNT]=12;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
    value(extension(e,0,MT_MAT_SPECULAR_ANISOTROPY),.65);
    value(extension(e,1,MT_MAT_SPECULAR_ANISOTROPY_ROTATION),.2);
    value(extension(e,2,MT_MAT_COAT_WEIGHT),.75);
    uint32_t x=extension(e,3,MT_MAT_COAT_COLOR);vector(x,.6,.8,1);
    words[extension(e,4,MT_MAT_COAT_NORMAL_MAP)]=2;
    x=extension(e,5,MT_MAT_COAT_NORMAL_SCALE);value(x,.5);value(x+1,.8);
    value(extension(e,6,MT_MAT_FUZZ_WEIGHT),.25);
    x=extension(e,7,MT_MAT_FUZZ_COLOR);vector(x,1,.2,.1);
    words[extension(e,8,MT_MAT_FUZZ_COLOR_MAP)]=1;
    words[extension(e,9,MT_MAT_SPECULAR_WEIGHT_MAP)]=3;
    words[extension(e,10,MT_MAT_MAP)]=1;
    x=extension(e,11,MT_MAT_UV_PROJECTION_SCALE);value(x,1.2);value(x+1,.8);
    if(!strcmp(variant,"v2-film")){
      e=reserve(4*MT_EXTENSION_WORDS);m=materials+2*MT_MATERIAL_WORDS;
      words[m+MT_MATERIAL_EXTENSION_COUNT]=4;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
      value(extension(e,0,MT_MAT_THIN_FILM_WEIGHT),1);
      value(extension(e,1,MT_MAT_THIN_FILM_THICKNESS),.45);
      words[extension(e,2,MT_MAT_THIN_FILM_MAP)]=1;
      words[extension(e,3,MT_MAT_THIN_FILM_MAP_CHANNEL)]=2;
    }
    if(!strcmp(variant,"v2-medium")){
      e=reserve(6*MT_EXTENSION_WORDS);m=materials+3*MT_MATERIAL_WORDS;
      words[m+MT_MATERIAL_EXTENSION_COUNT]=6;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
      value(extension(e,0,MT_MAT_TRANSMISSION_DEPTH),.5);
      vector(extension(e,1,MT_MAT_TRANSMISSION_COLOR),.6,.85,1);
      vector(extension(e,2,MT_MAT_TRANSMISSION_SCATTER),.2,.1,.05);
      value(extension(e,3,MT_MAT_TRANSMISSION_SCATTER_ANISOTROPY),.3);
      value(extension(e,4,MT_MAT_TRANSMISSION_DISPERSION_SCALE),.2);
      value(extension(e,5,MT_MAT_TRANSMISSION_DISPERSION_ABBE_NUMBER),30);
      words[MT_HEADER_QUALITY_FLAGS]=MT_QUALITY_DISPERSION;
    }
    if(!strcmp(variant,"v2-alpha")){
      e=reserve(4*MT_EXTENSION_WORDS);m=materials+MT_MATERIAL_WORDS;
      words[m+MT_MATERIAL_EXTENSION_COUNT]=4;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
      words[extension(e,0,MT_MAT_ALPHA_MODE)]=2;
      value(extension(e,1,MT_MAT_ALPHA_CUTOFF),.5);
      words[extension(e,2,MT_MAT_ALPHA_MAP)]=1;
      words[extension(e,3,MT_MAT_DOUBLE_SIDED)]=1;
    }
    if(!strcmp(variant,"v2-bevel")){
      e=reserve(MT_EXTENSION_WORDS);m=materials+MT_MATERIAL_WORDS;
      words[m+MT_MATERIAL_EXTENSION_COUNT]=1;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
      value(extension(e,0,MT_MAT_BEVEL_SIZE),.03);
      words[MT_HEADER_QUALITY_FLAGS]=MT_QUALITY_BEVEL;
    }
  }
  if(!strcmp(variant,"v2-vertices")||!strcmp(variant,"v2-multimaterial")){
    /* Unshare the floor's vertices so each triangle can select its own material. */
    uint32_t oldp=words[geos+MT_GEOMETRY_POSITION],oldn=words[geos+MT_GEOMETRY_NORMAL],olduv=words[geos+MT_GEOMETRY_UV];
    uint32_t p=reserve(18),nn=reserve(18),uu=reserve(12),ii=reserve(6),cc=reserve(18),tt=reserve(24),mm=reserve(6);
    for(uint32_t i=0;i<6;i++){
      uint32_t source=floor_indices[i];memcpy(words+p+i*3,words+oldp+source*3,12);memcpy(words+nn+i*3,words+oldn+source*3,12);memcpy(words+uu+i*2,words+olduv+source*2,8);
      words[ii+i]=i;words[mm+i]=i<3?0:1;vector(cc+i*3,.4+.1*i,1,.5);value(tt+i*4,1);value(tt+i*4+3,1);
    }
    words[geos+MT_GEOMETRY_VERTEX_COUNT]=6;words[geos+MT_GEOMETRY_POSITION]=p;words[geos+MT_GEOMETRY_INDICES]=ii;
    words[geos+MT_GEOMETRY_NORMAL]=nn;words[geos+MT_GEOMETRY_UV]=uu;words[geos+MT_GEOMETRY_UV1]=uu;
    words[geos+MT_GEOMETRY_COLOR]=cc;words[geos+MT_GEOMETRY_TANGENT]=tt;words[geos+MT_GEOMETRY_MATERIAL_INDEX]=mm;
    uint32_t table=reserve(2);words[table]=0;words[table+1]=1;
    words[meshes+MT_MESH_MATERIAL_TABLE]=table;words[meshes+MT_MESH_MATERIAL_COUNT]=2;
    if(!strcmp(variant,"v2-multimaterial")){
      uint32_t other=reserve(2),mesh1=meshes+MT_MESH_WORDS;words[other]=2;words[other+1]=3;
      words[mesh1+MT_MESH_GEOMETRY]=0;words[mesh1+MT_MESH_MATERIAL_TABLE]=other;words[mesh1+MT_MESH_MATERIAL_COUNT]=2;
    }
  }
  if(!strcmp(variant,"v2-instances")||!strcmp(variant,"v2-empty-batch")){
    uint32_t descriptors=reserve(4*MT_BATCH_WORDS);words[MT_HEADER_BATCH_OFFSET]=descriptors;
    if(!strcmp(variant,"v2-instances")){
      for(uint32_t i=0;i<4;i++)words[descriptors+i*MT_BATCH_WORDS+MT_BATCH_COUNT]=MT_BATCH_ORDINARY_MESH;
      uint32_t transforms=reserve(3*16),colors=reserve(3*3),io=descriptors+MT_BATCH_WORDS;
      words[io+MT_BATCH_COUNT]=3;words[io+MT_BATCH_TRANSFORMS]=transforms;words[io+MT_BATCH_COLORS]=colors;
      for(uint32_t i=0;i<3;i++){matrix(transforms+i*16,.7,i*.9,i*.9,-(double)i*.3);vector(colors+i*3,i==0?1:.3,i==1?1:.3,i==2?1:.3);}
    }
  }
  if(displacement_or_photometric && !strncmp(variant,"v3-displacement-",16)) {
    int projected=!strcmp(variant,"v3-displacement-triplanar")||!strcmp(variant,"v3-displacement-spherical")||!strcmp(variant,"v3-displacement-cylindrical");
    uint32_t m=materials+(projected?MT_MATERIAL_WORDS:0),e=reserve(5*MT_EXTENSION_WORDS);
    words[m+MT_MATERIAL_EXTENSION_COUNT]=5;words[m+MT_MATERIAL_EXTENSION_OFFSET]=e;
    words[extension(e,0,MT_MAT_DISPLACEMENT_MAP)]=1;
    value(extension(e,1,MT_MAT_DISPLACEMENT_SCALE),!strcmp(variant,"v3-displacement-negative")?-.35:!strcmp(variant,"v3-displacement-zero")?0:.35);
    value(extension(e,2,MT_MAT_DISPLACEMENT_STEP_SIZE),.02);
    words[extension(e,3,MT_MAT_DISPLACEMENT_UV_PROJECTION)]=!strcmp(variant,"v3-displacement-triplanar")?1:!strcmp(variant,"v3-displacement-spherical")?2:!strcmp(variant,"v3-displacement-cylindrical")?3:0;
    value(extension(e,4,MT_MAT_DISPLACEMENT_UV_PROJECTION_SCALE),1);
    if(projected)words[geos+MT_GEOMETRY_WORDS+MT_GEOMETRY_UV]=0; /* exercise projective displacement without UVs */
    if(!strcmp(variant,"v3-displacement-bytes")) {
      uint32_t o=textures+MT_TEXTURE_WORDS,pixels=reserve(16);words[o+MT_TEXTURE_STORAGE]=MT_TEXTURE_STORAGE_RGBA8_SRGB;words[o+MT_TEXTURE_PIXELS]=pixels;
      for(uint32_t i=0;i<16;i++)words[pixels+i]=(i%2)?0xffc06020u:0xff20c0e0u;
    }
  }
  if(displacement_or_photometric && (!strcmp(variant,"v3-ies")||!strcmp(variant,"v3-ies-shared"))) {
    const char *ies="IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 5 3 1 2 0 0 0 1 1 20\n0 20 45 70 90\n0 90 180\n100 90 40 5 0 80 60 15 0 0 50 30 5 0 0\n";
    size_t len=strlen(ies);uint32_t text=reserve((uint32_t)((len+3)/4));memcpy(words+text,ies,len);
    words[lights+MT_LIGHT_TYPE]=MT_LIGHT_TYPE_SPOT;value(lights+MT_LIGHT_INTENSITY,200);value(lights+MT_LIGHT_SIZE,.15);
    value(lights+MT_LIGHT_HEIGHT_OR_INNER,20);value(lights+MT_LIGHT_SPREAD_OR_OUTER,70);
    words[lights+MT_LIGHT_IES_OFFSET]=text;words[lights+MT_LIGHT_IES_BYTES]=(uint32_t)len;
    if(light_count==2){
      /* A second spot light reusing the same IES offset/length shares the profile. */
      uint32_t second=lights+MT_LIGHT_WORDS;memcpy(words+second,words+lights,MT_LIGHT_WORDS*4);value(second+MT_LIGHT_TRANSFORM+12,1.5);
    }
  }
  if(!strcmp(variant,"v3-rect-texture"))words[lights+MT_LIGHT_TEXTURE]=2;
  words[MT_HEADER_LENGTH]=used;return used*MT_WORD_BYTES;
}
int main(int argc,char **argv) {
  if(argc<3||argc>5)return 2;
  const char *variant=argc>=4?argv[3]:"baseline";
  const char *variants[]={"baseline","textures","transforms","orthographic","emissive","missing-normals","float-textures","sphere-light","directional-light","spot-light","disk-light","cylinder-light","lights-1024","alpha","v2-environment","v2-environment-only","v2-background","v2-hidden-background","v2-film","v2-medium","v2-alpha","v2-bevel","v2-vertices","v2-multimaterial","v2-instances","v2-empty-batch","v3-displacement-uv","v3-displacement-triplanar","v3-displacement-spherical","v3-displacement-cylindrical","v3-displacement-negative","v3-displacement-bytes","v3-displacement-zero","v3-ies","v3-ies-shared","v3-rect-texture"};
  int known=0;for(size_t i=0;i<sizeof(variants)/sizeof(variants[0]);i++)if(!strcmp(variant,variants[i]))known=1;
  if(!known)return 2;
  if(argc==5&&strcmp(argv[4],"repeat"))return 2;
  unsigned long samples=strtoul(argv[2],NULL,10);if(samples>4096)return 2;
  size_t size=make_scene(variant);char error[4096]={0};
  if(!samples){FILE *file=fopen(argv[1],"wb");if(!file||fwrite(words,1,size,file)!=size)return 4;fclose(file);return 0;}
  /* Each malformed descriptor below must be rejected before the valid render. */
  uint32_t old=words[MT_HEADER_VERSION];words[MT_HEADER_VERSION]=99;
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  words[MT_HEADER_VERSION]=old;
  uint32_t mesh_geometry=words[MT_HEADER_MESH_OFFSET]+MT_MESH_GEOMETRY;
  old=words[mesh_geometry];words[mesh_geometry]=999999;
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  words[mesh_geometry]=old;
  if(mt_probe_render_scene((uint8_t*)words,size-4,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  uint32_t light=words[MT_HEADER_LIGHT_OFFSET];
  if(words[light+MT_LIGHT_IES_BYTES]){
    uint32_t off=words[light+MT_LIGHT_IES_OFFSET],saved=words[off];words[off]=0;
    if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
    words[off]=saved;
  }
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))){fprintf(stderr,"%s\n",error);return 1;}
  char path[4096];if(snprintf(path,sizeof(path),"%s/scene-input.bin",argv[1])>=(int)sizeof(path))return 2;
  FILE *file=fopen(path,"wb");if(!file||fwrite(words,1,size,file)!=size)return 4;fclose(file);
  if(argc==5){
    if(snprintf(path,sizeof(path),"%s/repeat",argv[1])>=(int)sizeof(path))return 2;
    if(mt_probe_render_scene((uint8_t*)words,size,path,(uint32_t)samples,error,sizeof(error))){fprintf(stderr,"%s\n",error);return 1;}
  }
  return 0;
}
