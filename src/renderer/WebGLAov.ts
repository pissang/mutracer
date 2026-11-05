import displayShader from './glsl/aovDisplay.frag.js';
import {WebGLFullQuadPass} from './WebGLFullQuadPass.js';
import {aovLaneKind} from './aov.js';
import {AOV_ID_COMPONENTS, validateAovDisplay, type AovDisplayOptions} from './aovDisplay.js';
import {AovHistory, type AovKind, type AovFrameSnapshot} from './aov.js';
import {Texture2D, FrameBuffer, type WebGLDevice} from './webgl.js';
import {readRgbaPixels} from './WebGLReadback.js';
const names = ['geometry','position','diffuse','specular'] as const;
export class WebGLAov {
  private displayPass?: WebGLFullQuadPass<string,'color'>;
  readonly history=new AovHistory();
  width=0; height=0; samples=0; centerReady=false; frame?: AovFrameSnapshot;
  readonly accumulation: Record<typeof names[number],Texture2D>[]=[];
  previousCenter: {id:Texture2D; motion:Texture2D} | undefined;
  center: {id:Texture2D; motion:Texture2D} | undefined;
  scene = new Texture2D({type: 5125, minFilter:9728,magFilter:9728});
  constructor(readonly renderer: WebGLDevice) {}
  reset(){if(this.centerReady){const swap=this.previousCenter;this.previousCenter=this.center;this.center=swap;}this.samples=0;this.centerReady=false;this.frame=undefined;}
  resize(width:number,height:number){
    if(width===this.width && height===this.height)return;
    this.dispose();this.history.clear();this.reset();this.width=width;this.height=height;
    const options={width,height,type:5126,minFilter:9728,magFilter:9728};
    for(let i=0;i<2;i++)this.accumulation.push(Object.fromEntries(names.map(n=>[n,new Texture2D(options)])) as Record<typeof names[number],Texture2D>);
    this.previousCenter={id:new Texture2D({...options,type:5125}),motion:new Texture2D(options)};
    this.center={id:new Texture2D({...options,type:5125}),motion:new Texture2D(options)};
  }
  setScene(words:Uint32Array){
    const width=Math.min(1024,Math.max(1,Math.ceil(words.length/4))),height=Math.ceil(words.length/(width*4));
    const data=new Uint32Array(width*height*4);data.set(words);
    this.scene.source={data,width,height};
  }
  visualize(kind:AovKind,options:AovDisplayOptions):Texture2D {
    if(!this.samples || !this.center)throw new Error('AOV output is not ready');
    validateAovDisplay(options);
    this.displayPass??=new WebGLFullQuadPass('AOV display',this.renderer,{shader:displayShader,outputs:['color']});
    const pass=this.displayPass;pass.setSize(this.width,this.height);pass.setUniforms({kind:aovLaneKind(kind),samples:this.samples,mapping:[...options.depthRange,options.positionScale,options.motionScale],idComponent:AOV_ID_COMPONENTS.indexOf(options.idComponent)});
    pass.createPass({...this.accumulation[(this.samples-1)%2],identity:this.center.id,motion:this.center.motion});return pass.getOutput('color');
  }
  async read(kind:AovKind){
    const gl=this.renderer.gl, framebuffer=new FrameBuffer(), width=this.width,height=this.height;
    try{
      const accumulated=this.accumulation[(this.samples-1)%2];
      const name=kind==='depth'||kind==='roughness'?'geometry':aovLaneKind(kind)===3?'diffuse':aovLaneKind(kind)===4?'specular':'position';
      framebuffer.bind(this.renderer,[kind==='id'?this.center!.id:kind==='motion'?this.center!.motion:accumulated[name]]);
      if(kind==='id'){
        const source=new Uint32Array(width*height*4),data=new Uint32Array(source.length);
        gl.readPixels(0,0,width,height,gl.RGBA_INTEGER,gl.UNSIGNED_INT,source);
        for(let y=0;y<height;y++)data.set(source.subarray((height-1-y)*width*4,(height-y)*width*4),y*width*4);
        return {width,height,data};
      }
      const data=readRgbaPixels(gl,width,height,false);
      if(kind==='motion'){for(let o=2;o<data.length;o+=4)data[o]=0;return {width,height,data};}
      framebuffer.bind(this.renderer,[accumulated.position]);const coverage=readRgbaPixels(gl,width,height,false);
      for(let p=0;p<width*height;p++){
        const o=p*4,hits=coverage[o+3],inv=hits>0?1/hits:0,alpha=hits/Math.max(1,this.samples);
        if(kind==='depth')data.set([data[o]*inv,0,0,alpha],o);
        else if(kind==='roughness')data.set([data[o+1]*inv,data[o+2]*inv,data[o+3]*inv,alpha],o);
        else if(kind==='position')data.set([data[o]*inv,data[o+1]*inv,data[o+2]*inv,alpha],o);
        else{const count=data[o+3],scale=count>0?1/count:0;data.set([data[o]*scale,data[o+1]*scale,data[o+2]*scale,count/Math.max(1,this.samples)],o);}
      }
      return {width,height,data};
    }finally{framebuffer.dispose(this.renderer);}
  }
  get bytes(){return this.width*this.height*(2*64+64+(this.displayPass?4:0))+this.scene.width*this.scene.height*16;}
  dispose(){this.displayPass?.dispose();this.displayPass=undefined;const gl=this.renderer.gl;for(const set of this.accumulation)for(const texture of Object.values(set))texture.dispose(gl);this.accumulation.length=0;this.center?.id.dispose(gl);this.center?.motion.dispose(gl);this.center=undefined;this.previousCenter?.id.dispose(gl);this.previousCenter?.motion.dispose(gl);this.previousCenter=undefined;this.scene.dispose(gl);}
}
