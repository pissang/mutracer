import {describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.stubGlobal('location',{href:'https://viewer.example.com/',search:'',hash:'',pathname:'/'});vi.stubGlobal('document',{baseURI:'https://viewer.example.com/'});vi.stubGlobal('window',{});vi.stubGlobal('history',{replaceState:vi.fn()});});
import {WebEngine} from '../src/engine/WebEngine';
import {MATERIALX_SAMPLES,materialXSampleFiles} from '../src/engine/materialxSamples';
import {parseMaterialXGraph} from '../src/engine/materialxGraph';
import {parseMaterialX} from '../src/engine/materialx';
import {bakeHeightCPU} from '../src/engine/materialxBake';
import {isMaterialXDrop} from '../src/engine/materialDrop';
import {bakeDisplacement} from '../src/engine/materialxBakeClient';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize';
vi.mock('../src/engine/materialxBakeClient',()=>({bakeDisplacement:vi.fn()}));

const sample=(id:string)=>{const s=MATERIALX_SAMPLES.find(s=>s.id===id);if(!s)throw Error(`missing sample ${id}`);return s;};

// Graph-driven OpenPBR inputs and folded constants each sample is meant to exercise.
const expected:Record<string,{terminals:string[];values?:Record<string,unknown>}>={
  'car-paint':{terminals:['baseColor','baseMetalness','specularRoughness','normal'],values:{coatWeight:1,coatColor:[0.55,0.012,0.03],coatRoughness:0.03,coatIor:1.5}},
  'weathered-steel':{terminals:['baseColor','baseMetalness','specularRoughness','specularAnisotropy','normal']},
  'varnished-wood':{terminals:['baseColor','specularRoughness','normal'],values:{coatWeight:0.85,coatRoughness:0.06}},
  'marble':{terminals:['baseColor','specularRoughness'],values:{subsurfaceWeight:0.3,subsurfaceRadius:0.06}},
  'terrazzo':{terminals:['baseColor','specularRoughness']},
  'leather':{terminals:['baseColor','specularRoughness','normal'],values:{fuzzWeight:0.08}},
  'tartan-velvet':{terminals:['baseColor','fuzzColor','normal'],values:{fuzzWeight:0.7,fuzzRoughness:0.45}},
  'cobblestone':{terminals:['baseColor','specularRoughness']},
  'zellige-tile':{terminals:['baseColor','specularRoughness','normal']},
  'candle-wax':{terminals:['baseColor','specularRoughness','normal'],values:{subsurfaceWeight:0.6,subsurfaceRadius:0.25,subsurfaceColor:[0.92,0.55,0.18],transmissionWeight:0.1}},
  'hammered-copper':{terminals:['baseColor','specularRoughness','normal'],values:{baseMetalness:1}},
  'carbon-fiber':{terminals:['baseColor','specularRoughness','normal'],values:{coatWeight:1,coatRoughness:0.04}},
  'damascus-steel':{terminals:['baseColor','specularRoughness','normal']},
  'kintsugi':{terminals:['baseColor','baseMetalness','specularRoughness','normal']},
  'heat-tinted-titanium':{terminals:['specularRoughness','thinFilmThickness'],values:{baseMetalness:1,specularAnisotropy:0.4,thinFilmIor:2.6}},
  'abalone':{terminals:['specularRoughness','thinFilmThickness','normal'],values:{baseMetalness:1,thinFilmIor:2.4}},
  'hex-plating':{terminals:['baseColor','specularRoughness','normal']},
  'brick-wall':{terminals:['baseColor','specularRoughness']},
  'wet-asphalt':{terminals:['baseColor','specularRoughness','thinFilmWeight','thinFilmThickness','normal'],values:{thinFilmIor:1.45}},
  'chipped-paint':{terminals:['baseColor','baseMetalness','specularRoughness','normal']},
  'knit-wool':{terminals:['baseColor','fuzzColor','normal'],values:{fuzzWeight:0.85,fuzzRoughness:0.55}},
  'perforated-metal':{terminals:['baseColor','specularRoughness','opacity','normal'],values:{baseMetalness:1}},
  'circuit-board':{terminals:['baseColor','baseMetalness','specularRoughness','normal']},
  'stained-glass':{terminals:['baseColor','baseMetalness','specularRoughness','transmissionWeight','transmissionColor','normal'],values:{thinWalled:true}},
  'rain-glass':{terminals:['specularRoughness','normal'],values:{transmissionWeight:1,specularIor:1.45}},
  'agate':{terminals:['baseColor','specularRoughness','normal'],values:{subsurfaceWeight:0.25,subsurfaceRadius:0.1}},
  'guilloche-enamel':{terminals:['baseColor','specularRoughness','normal'],values:{coatWeight:1,coatColor:[0.03,0.2,0.75]}},
  'dragon-scales':{terminals:['baseColor','specularRoughness','thinFilmThickness','normal'],values:{thinFilmIor:2.2}},
  'holo-glitter':{terminals:['baseColor','specularRoughness','thinFilmThickness','normal'],values:{thinFilmIor:2.6}},
  'gas-giant':{terminals:['baseColor'],values:{fuzzWeight:0.6}},
  'cooling-lava':{terminals:['baseColor','specularRoughness','normal','emissionColor','emissionLuminance']},
  'hex-panel':{terminals:['baseColor','specularRoughness','normal','emissionColor','emissionLuminance'],values:{baseMetalness:1}}
};
// Samples with a UV-only height, and their displacement scale.
const displaced:Record<string,number>={'cobblestone':0.04,'brick-wall':0.03};

describe('bundled MaterialX samples',()=>{
  it('lists every sample in panel order and packages it as a MaterialX drop',()=>{
    expect(MATERIALX_SAMPLES.map(s=>s.id)).toEqual(Object.keys(expected));
        for(const s of MATERIALX_SAMPLES)expect(isMaterialXDrop(materialXSampleFiles(s))).toBe(true);
  });

  it.each(Object.entries(expected))('imports %s as a complete graph with its constants folded',(id,{terminals,values})=>{
    const m=parseMaterialXGraph(sample(id).text);
    expect(m.warnings).toEqual([]);
    expect(m.coverage).toBe('complete');
    expect(m.images.size).toBe(0);
    expect(Object.keys(m.graph!.terminal)).toEqual(expect.arrayContaining(terminals));
    expect(normalizeGraph(m.graph!).diagnostics).toEqual([]);
    for(const [key,value] of Object.entries(values??{})){
      if(Array.isArray(value))(m.values as Record<string,number[]>)[key].forEach((v,i)=>expect(v).toBeCloseTo(value[i] as number));
      else expect((m.values as Record<string,number>)[key]).toBeCloseTo(value as number);
    }
  });

  it.each(MATERIALX_SAMPLES.map(s=>[s.id,s.text]))('exposes %s interface inputs as graph parameters, not structure',(_,text)=>{
    const base=normalizeGraph(parseMaterialXGraph(text).graph!);
    const interfaces=[...text.matchAll(/<nodegraph[^>]*>([\s\S]*?)<\/nodegraph>/g)][0][1].matchAll(/<input name="(\w+)" type="(float|color3|vector2)" value="([^"]+)"/g);
    let edited=0;
    for(const [declaration,name,type,value] of interfaces){
      const changed=value.split(',').map(v=>Number(v)*0.7+0.11);
      const variant=normalizeGraph(parseMaterialXGraph(text.replace(declaration,`<input name="${name}" type="${type}" value="${changed.join(', ')}"`)).graph!);
      expect(variant.key,name).toBe(base.key);
      const differs=variant.parameters.some((p,i)=>JSON.stringify(p)!==JSON.stringify(base.parameters[i]));
      expect(differs,`${name} reaches a parameter`).toBe(true);
      edited++;
    }
    expect(edited).toBeGreaterThanOrEqual(5);
  });

  it('bakes the cobblestone height from UV0 into stones above the mortar',()=>{
    const m=parseMaterialXGraph(sample('cobblestone').text);
    expect(m.displacement).toMatchObject({mode:'bake',uvChannel:0});
    expect(m.displacement!.reason).toBeUndefined();
    const {heights}=bakeHeightCPU(m.displacement!.graph,[],32,16);
    const min=Math.min(...heights),max=Math.max(...heights);
    expect(heights.every(Number.isFinite)).toBe(true);
    // Mortar sits near zero; domed tops reach most of the 0.04 scale.
    expect(min).toBeLessThan(0.006);
    expect(max).toBeGreaterThan(0.03);
    expect(max).toBeLessThan(0.06);
  });

  it('bakes the brick wall height from UV0 into bricks above the mortar',()=>{
    const m=parseMaterialXGraph(sample('brick-wall').text);
    expect(m.displacement).toMatchObject({mode:'bake',uvChannel:0});
    expect(m.displacement!.reason).toBeUndefined();
    const {heights}=bakeHeightCPU(m.displacement!.graph,[],64,64);
    expect(heights.every(Number.isFinite)).toBe(true);
    // Mortar is at zero; bricks stand 0.72 to 1 of the 0.03 scale, plus pitting.
    expect(Math.min(...heights)).toBeLessThan(0.004);
    expect(Math.max(...heights)).toBeGreaterThan(0.02);
    expect(Math.max(...heights)).toBeLessThan(0.045);
  });

  it('leaves displacement off for every other sample',()=>{
    for(const s of MATERIALX_SAMPLES.filter(s=>!(s.id in displaced)))expect(parseMaterialXGraph(s.text).displacement).toBeUndefined();
  });

  it('keeps a constant fallback for each sample that reports the graph-only nodes',()=>{
    for(const s of MATERIALX_SAMPLES){
      const fallback=parseMaterialX(s.text);
      expect(fallback.warnings.length,s.id).toBeGreaterThan(0);
      expect(fallback.maps,s.id).toEqual({});
    }
    expect(parseMaterialX(sample('candle-wax').text).values).toMatchObject({subsurfaceWeight:0.6,subsurfaceRadius:0.25});
  });

  it('reports an unsupported node and keeps the constant material values',()=>{
    // heighttonormal is MaterialX 1.39 stdlib, but not a graph category here.
    const text=sample('varnished-wood').text.replace(/<normalize name="bumped_normal"[\s\S]*?<\/normalize>/,
      '<heighttonormal name="bumped_normal" type="vector3"><input name="in" type="float" nodename="grain" /><input name="scale" type="float" value="0.5" /></heighttonormal>');
    const m=parseMaterialXGraph(text);
    expect(m.warnings).toContainEqual(expect.stringContaining('Unsupported MaterialX category heighttonormal'));
    expect(m.coverage).toBe('partial');
    expect(m.values).toMatchObject({coatWeight:0.85,coatRoughness:0.06});
  });

  it('reports a varying subsurface color, which graphs cannot drive',()=>{
    const text=sample('candle-wax').text.replace('<input name="subsurface_color" type="color3" value="0.92, 0.55, 0.18" />',
      '<input name="subsurface_color" type="color3" nodegraph="NG_candle_wax" output="base_color_out" />');
    const m=parseMaterialXGraph(text);
    expect(m.warnings).toContainEqual(expect.stringContaining('Unsupported OpenPBR graph input subsurfaceColor'));
    expect(m.values.subsurfaceWeight).toBeCloseTo(0.6);
  });

  it.each(MATERIALX_SAMPLES.map(s=>[s.id]))('imports %s through the viewer as one material replacement',async id=>{
    vi.mocked(bakeDisplacement).mockResolvedValue({file:new Blob(['height']),scale:displaced[id]??0.04,bias:0,maxError:0.04/510,width:1024,height:1024,backend:'cpu',timings:{compileMs:0,executeMs:1,readbackMs:0,cacheHit:false}});
    const setTextures=vi.fn(async()=>true),receiver={materials:{setTextures}};
    expect(await WebEngine.prototype.importMaterialX.call(receiver as unknown as WebEngine,'target',materialXSampleFiles(sample(id)))).toBe(true);
    expect(setTextures).toHaveBeenCalledTimes(1);
    const args=setTextures.mock.calls[0] as unknown as unknown[];
    expect(args[3]).toMatch(/^[A-Z][A-Za-z_]+ MaterialX$/);
    expect(Object.keys((args[6] as {terminal:object}).terminal)).toEqual(expect.arrayContaining(expected[id].terminals));
    if(id in displaced)expect(args[2]).toMatchObject({displacementScale:displaced[id],displacementBias:0});
    else expect((args[1] as Record<string,unknown>).displacementMap).toBeNull();
  });
});
