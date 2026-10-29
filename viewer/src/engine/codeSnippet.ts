import {causticOptions} from '../caustics';
import * as THREE from 'three';
import { DEFAULT_JNLM_OPTIONS, VERSION, type DenoiserOptions } from '@meimu/mutracer';
import { VIEWER_AOVS, type Settings } from '../store';
import { getDenoiserOptions } from './denoiserSettings';

type Vec3 = [number, number, number];

/** What {@link generateCode} needs from the running viewer. */
export interface CodeSnapshot {
  settings: Settings;
  webgpu: boolean;
  /** glTF URL; `null` writes a placeholder for local files and built-in scenes. */
  modelUrl: string | null;
  /** .hdr URL; `null` writes a placeholder for the procedural sky and uploads. */
  environmentUrl: string | null;
  /** Scene lighting with no infinite emitter needs no environment download. */
  blackEnvironment?: boolean;
  /** Lights added from metadata rather than standard glTF nodes. */
  metadataLights?: { color: Vec3; intensity: number; position: Vec3; target: Vec3 }[];
  camera: {
    projection: 'perspective' | 'orthographic';
    /** Vertical field of view in degrees, perspective only. */
    fov: number;
    /** Orthographic half height before zoom. */
    halfHeight: number;
    zoom: number;
    near: number;
    far: number;
    position: Vec3;
    target: Vec3;
    up: Vec3;
  };
  /** Focus distance of the current frame. */
  focusDistance: number;
  metersPerUnit: number;
  /** Side length of the shadow-catcher ground. */
  groundSize: number;
  /** Resolved grounded skybox projection. */
  grounded: { height: number; radius: number };
  /** Studio rect lights in world space. */
  studioLights: { name: string; intensity: number; width: number; height: number; position: Vec3; quaternion: [number, number, number, number] }[];
  /** Playing animation clip. */
  animation: { clip: number; speed: number; loop: boolean } | null;
}

/** Library defaults the code leaves out. */
const RENDER_DEFAULTS = { maxSamples: 2048, bounces: 3, resolutionScale: 1, samplingPattern: 'sobol', clamping: 0 };
const PREVIEW_DEFAULTS = { resolutionScale: 0.5, minScale: 0.125, bounces: 2 };
const DISPLAY_DEFAULTS: [keyof Settings, string, unknown][] = [
  ['toneMapping', 'toneMapping', 'agx'], ['exposure', 'toneMappingExposure', 1], ['contrast', 'contrast', 1],
  ['saturation', 'saturation', 1], ['temperature', 'temperature', 0], ['tint', 'tint', 0],
  ['bloomIntensity', 'bloomIntensity', 0], ['bloomThreshold', 'bloomThreshold', 1], ['bloomRadius', 'bloomRadius', 0.6],
  ['vignette', 'vignette', 0], ['output', 'channel', 'final'], ['hdrOutputEnabled', 'hdrOutputEnabled', false]
];

/** Short number literal. */
const num = (value: number) => String(Number(value.toPrecision(6)));
const vec = (values: readonly number[]) => values.map(num).join(', ');
const literal = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'number') return num(value);
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean' || value === null) return String(value);
  return object(value as Record<string, unknown>);
};
const object = (fields: Record<string, unknown>) => {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  return entries.length ? `{ ${entries.map(([k, v]) => `${k}: ${literal(v)}`).join(', ')} }` : '{}';
};

/** Denoiser options without library defaults and viewer-only hosting. */
function denoiser(settings: Settings, webgpu: boolean, preview: boolean) {
  const options = getDenoiserOptions(settings, webgpu, '', preview) as (DenoiserOptions & Record<string, unknown>) | null;
  if (!options) return undefined;
  const out: Record<string, unknown> = { ...options };
  delete out.weightsBaseUrl;
  if (out.schedule === 'converged') delete out.schedule;
  if (out.model === 'standard') delete out.model;
  if (out.maxTileSize === undefined) delete out.maxTileSize;
  for (const [key, value] of Object.entries(DEFAULT_JNLM_OPTIONS)) if (out[key] === value) delete out[key];
  return out;
}

/**
 * Shortest MuTracer + Three.js program that renders what the viewer shows:
 * the model, lighting, background, ground, camera and render and display
 * settings, leaving out anything at its library default.
 */
export function generateCode(snapshot: CodeSnapshot): string {
  const s = snapshot.settings;
  const studio = s.lighting === 'studio';
  const procedural = !studio && s.envId === 'sky' && !snapshot.environmentUrl && !snapshot.blackEnvironment;
  const hdr = !studio && !procedural && !snapshot.blackEnvironment;
  const cam = snapshot.camera;
  const ortho = cam.projection === 'orthographic';
  const lens = !ortho && s.fStop > 0;
  const lines: string[] = [];
  const out = (...rows: string[]) => lines.push(...rows);
  const imports = ['Engine', 'RenderLoop', 'THREESync'];
  if (lens || snapshot.animation) imports.push('Sync');
  if (procedural) imports.push('ProceduralSky');

  const placeholders = [
    ...(snapshot.modelUrl ? [] : ['./model.glb']),
    ...(!hdr || snapshot.environmentUrl ? [] : ['./environment.hdr'])
  ];
  out(
    `// Generated by MuTracer Viewer for @meimu/mutracer ${VERSION}, ${snapshot.webgpu ? 'WebGPU' : 'WebGL 2'} backend.`,
    '// Reproduces the model, lighting, background, ground, camera, render and display',
    '// settings; settings at their library defaults are left out.',
    '// Not included: material edits and hidden objects.',
    ...(placeholders.length ? [`// Placeholders to replace: ${placeholders.join(', ')}.`] : []),
    '// Needs an ES module bundler with top-level await and a <canvas> on the page; with Vite,',
    "// set optimizeDeps: { exclude: ['@meimu/mutracer'] }. Usage guide for coding agents:",
    '// https://github.com/pissang/mutracer/blob/main/llms.txt',
    '',
    "import * as THREE from 'three';",
    "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
    ...(hdr ? ["import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';"] : []),
    "import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';",
    `import { ${imports.join(', ')} } from '@meimu/mutracer';`,
    '',
    "const canvas = document.querySelector('canvas');",
    'const scene = new THREE.Scene();',
    ''
  );

  // Lighting and background.
  let env: string | null = null;
  if (studio) {
    out(
      '// Studio softboxes; rect lights emit along their local -Z.',
      'for (const [intensity, width, height, x, y, z, qx, qy, qz, qw] of ['
    );
    for (const light of snapshot.studioLights) {
      out(`  [${vec([light.intensity, light.width, light.height, ...light.position, ...light.quaternion])}],${light.name ? ` // ${light.name}` : ''}`);
    }
    out(
      ']) {',
      '  const light = new THREE.RectAreaLight(0xffffff, intensity, width, height);',
      '  light.position.set(x, y, z);',
      '  light.quaternion.set(qx, qy, qz, qw);',
      '  scene.add(light);',
      '}'
    );
    if (s.studioAmbient > 0) {
      // THREE.Color converts the sRGB hex to linear RGB.
      const tint = new THREE.Color(s.studioAmbientColor);
      env = 'ambient';
      out(
        '',
        '// Dim ambient fill, brighter overhead and darker toward the floor.',
        'const pixels = new Float32Array(64 * 32 * 4);',
        'for (let i = 0; i < 64 * 32; i++) {',
        '  const y = Math.cos(((Math.floor(i / 64) + 0.5) / 32) * Math.PI);',
        '  const v = y >= 0 ? 0.6 + 0.4 * y : 0.6 + 0.35 * y;',
        `  pixels.set([v * ${num(tint.r)}, v * ${num(tint.g)}, v * ${num(tint.b)}, 1], i * 4);`,
        '}',
        'const ambient = new THREE.DataTexture(pixels, 64, 32, THREE.RGBAFormat, THREE.FloatType);',
        'ambient.mapping = THREE.EquirectangularReflectionMapping;',
        '// Rows start at the sky, as in an .hdr file.',
        'ambient.flipY = true;',
        'ambient.needsUpdate = true;',
        'scene.environment = ambient;'
      );
    }
  } else if (procedural) {
    env = 'environment';
    out(`const environment = new ProceduralSky({ time: ${num(s.skyTime)} });`);
  } else if (hdr) {
    env = 'environment';
    out(
      ...(snapshot.environmentUrl ? [] : ['// Replace with your own equirectangular .hdr.']),
      `const environment = await new HDRLoader().loadAsync('${snapshot.environmentUrl ?? './environment.hdr'}');`,
      'environment.mapping = THREE.EquirectangularReflectionMapping;'
    );
    out('scene.environment = environment;');
  }
  const intensity = studio ? s.studioAmbient : s.envIntensity;
  const rotation = studio ? 0 : ((s.envRotation % 360) + 360) % 360;
  if (env) {
    if (intensity !== 1) out(`scene.environmentIntensity = ${num(intensity)};`);
    if (rotation !== 0) out(`scene.environmentRotation.y = THREE.MathUtils.degToRad(${num(rotation)});`);
  }
  if (s.background === 'transparent') {
    out('scene.userData.mutracerHiddenBackground = true;');
  } else if (s.background === 'color') {
    out(`scene.background = new THREE.Color('${s.backgroundColor}');`);
  } else if (s.background === 'grounded' && !studio && env) {
    out(`scene.userData.mutracerGroundedSkybox = { texture: environment, height: ${num(snapshot.grounded.height)}, radius: ${num(snapshot.grounded.radius)}, intensity: scene.environmentIntensity, rotation: scene.environmentRotation.y };`);
  } else if (!env) {
    out('scene.background = new THREE.Color(0, 0, 0);');
  }

  // Model, standing on the ground at the origin.
  out(
    '',
    ...(snapshot.modelUrl ? [] : ['// Replace with your own .glb or .gltf.']),
    `const gltf = await new GLTFLoader().loadAsync('${snapshot.modelUrl ?? './model.glb'}');`,
    'const model = gltf.scene;',
    'const box = new THREE.Box3().setFromObject(model, true);',
    'const center = box.getCenter(new THREE.Vector3());',
    'model.position.set(-center.x, -box.min.y, -center.z);',
    'scene.add(model);'
  );
  for (const light of snapshot.metadataLights ?? []) {
    out(
      '',
      '{',
      `  const light = new THREE.DirectionalLight(new THREE.Color(${vec(light.color)}), ${num(light.intensity)});`,
      `  light.position.set(${vec(light.position)});`,
      `  light.target.position.set(${vec(light.target)});`,
      '  scene.add(light, light.target);',
      '}'
    );
  }
  if (s.groundShadow) {
    out(
      '',
      '// Shadow-catcher ground.',
      `const ground = new THREE.Mesh(new THREE.PlaneGeometry(${num(snapshot.groundSize)}, ${num(snapshot.groundSize)}).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());`,
      'ground.material.userData.mutracerShadowCatcher = true;',
      'scene.add(ground);'
    );
  }

  // Camera.
  out('');
  if (ortho) {
    out(`const camera = new THREE.OrthographicCamera(-1, 1, ${num(cam.halfHeight)}, ${num(-cam.halfHeight)}, ${num(cam.near)}, ${num(cam.far)});`);
  } else {
    out(`const camera = new THREE.PerspectiveCamera(${num(cam.fov)}, 1, ${num(cam.near)}, ${num(cam.far)});`);
  }
  out(`camera.position.set(${vec(cam.position)});`);
  if (cam.up.some((v, i) => Math.abs(v - [0, 1, 0][i]) > 1e-6)) out(`camera.up.set(${vec(cam.up)});`);
  if (cam.zoom !== 1) out(`camera.zoom = ${num(cam.zoom)};`);
  if (lens) out(`camera.focus = ${num(snapshot.focusDistance)};`);
  out(
    'const controls = new OrbitControls(camera, canvas);',
    `controls.target.set(${vec(cam.target)});`,
    ...(s.autoRotate ? ['controls.autoRotate = true;'] : []),
    'controls.update();'
  );

  // Renderer.
  const syncs = ['sync'];
  out(
    '',
    'const engine = new Engine({ canvas });',
    `const sync = new THREESync(engine, { scene, camera, controls${procedural ? ', environment' : ''} });`
  );
  if (lens) {
    syncs.push('lens');
    out(
      '// THREESync converts the camera; add the lens after it.',
      'const lens = new class extends Sync {',
      `  update() { Object.assign(this.engine.camera, { fStop: ${num(s.fStop)}, metersPerUnit: ${num(snapshot.metersPerUnit)} }); }`,
      '}(engine);'
    );
  }
  if (snapshot.animation) {
    const { clip, speed, loop } = snapshot.animation;
    syncs.push('animation');
    out(
      'const mixer = new THREE.AnimationMixer(model);',
      `const action = mixer.clipAction(gltf.animations[${clip}]).play();`,
      ...(loop ? [] : ['action.setLoop(THREE.LoopOnce, 1);', 'action.clampWhenFinished = true;']),
      'let last = performance.now();',
      'const animation = new class extends Sync {',
      '  get active() { return true; }',
      `  update() { const now = performance.now(); mixer.update(((now - last) / 1000)${speed !== 1 ? ` * ${num(speed)}` : ''}); last = now; }`,
      '}(engine);'
    );
  }

  const display: Record<string, unknown> = {};
  for (const [key, name, fallback] of DISPLAY_DEFAULTS) if (s[key] !== fallback) display[name] = s[key];
  const aovs = VIEWER_AOVS.filter(kind => kind === s.output);
  if (aovs.length) {
    if (s.aovDepthFar !== 10) display.aovDepthRange = [0, s.aovDepthFar];
    if (s.aovPositionScale !== 1) display.aovPositionScale = s.aovPositionScale;
    if (s.aovMotionScale !== 16) display.aovMotionScale = s.aovMotionScale;
    if (s.aovIdComponent !== 'object') display.aovIdComponent = s.aovIdComponent;
  }
  if (s.groundShadow && s.groundOpacity !== 1) display.shadowCatcherAlpha = s.groundOpacity;
  if (Object.keys(display).length) out(`Object.assign(engine.display, ${object(display)});`);

  const final: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(RENDER_DEFAULTS) as [keyof typeof RENDER_DEFAULTS, unknown][]) {
    if (s[key] !== fallback) final[key] = s[key];
  }
  if (s.caustics) final.caustics = causticOptions(s);
  if (aovs.length) final.aovs = aovs;
  final.denoiser = denoiser(s, snapshot.webgpu, false);
  let preview: Record<string, unknown> | false = false;
  if (s.previewEnabled) {
    const scale = s.previewMaxResolutionScale;
    const minScale = Math.min(PREVIEW_DEFAULTS.minScale, scale);
    preview = {
      aovs: aovs.length ? aovs : undefined,
      resolutionScale: scale !== PREVIEW_DEFAULTS.resolutionScale ? scale : undefined,
      adaptiveResolution: minScale !== PREVIEW_DEFAULTS.minScale ? {targetFrameMs: 80, minScale} : undefined,
      bounces: Math.min(PREVIEW_DEFAULTS.bounces, s.bounces) !== PREVIEW_DEFAULTS.bounces ? s.bounces : undefined,
      samplingPattern: s.samplingPattern !== RENDER_DEFAULTS.samplingPattern ? s.samplingPattern : undefined,
      clamping: s.clamping !== RENDER_DEFAULTS.clamping ? s.clamping : undefined,
      caustics: causticOptions(s),
      denoiser: denoiser(s, snapshot.webgpu, true)
    };
  }
  const loopOptions = [syncs.length > 1 ? `sync: [${syncs.join(', ')}]` : 'sync'];
  if (preview === false) loopOptions.push('preview: false');
  else if (object(preview) !== '{}') loopOptions.push(`preview: ${object(preview)}`);
  if (object(final) !== '{}') loopOptions.push(`final: ${object(final)}`);
  if (s.previewEnabled && s.denoiseWhileConverging && s.denoise) loopOptions.push('coalesceSceneUpdates: true');
  out(
    'const loop = new RenderLoop(engine, {',
    ...loopOptions.map((option, i) => `  ${option}${i < loopOptions.length - 1 ? ',' : ''}`),
    '});',
    '',
    'new ResizeObserver(() => {',
    '  const scale = Math.min(devicePixelRatio, 2);',
    '  engine.display.setSize(Math.round(canvas.clientWidth * scale), Math.round(canvas.clientHeight * scale));',
    '  const aspect = canvas.clientWidth / canvas.clientHeight;',
    ...(ortho ? ['  camera.left = -camera.top * aspect;', '  camera.right = camera.top * aspect;'] : ['  camera.aspect = aspect;']),
    '  camera.updateProjectionMatrix();',
    '}).observe(canvas);',
    'loop.start();'
  );
  return lines.join('\n') + '\n';
}

/** Viewer context that {@link formatForAgent} adds around the code. */
export interface AgentContext {
  modelName: string | null;
  credit: string | null;
  /** Link that reopens the example model and shareable settings; `null` for local files. */
  viewerUrl: string | null;
  /** Viewer settings that differ from the viewer defaults. */
  changedSettings: Partial<Settings>;
}

/** The code as Markdown for a coding agent, with the viewer state it came from. */
export function formatForAgent(code: string, context: AgentContext): string {
  const docs = 'https://github.com/pissang/mutracer/blob/main';
  const lines = [
    '# MuTracer scene from MuTracer Viewer',
    '',
    'The JavaScript below renders the current MuTracer Viewer scene with `@meimu/mutracer` and Three.js.',
    'Its header comment lists what it leaves out and the placeholders to replace.',
    `Usage guide: ${docs}/llms.txt. API reference and defaults: ${docs}/docs/api.md.`,
    ''
  ];
  if (context.modelName) lines.push(`- Model: ${context.modelName}${context.credit ? ` (${context.credit})` : ''}`);
  if (context.viewerUrl) lines.push(`- Viewer link (model, lighting, exposure and tone mapping): ${context.viewerUrl}`);
  const changed = Object.keys(context.changedSettings).length;
  if (changed) {
    lines.push(
      '- Viewer settings changed from the viewer defaults. These are viewer UI names, not library options;',
      '  the code already applies them.',
      '',
      '```json',
      JSON.stringify(context.changedSettings, null, 2),
      '```'
    );
  }
  lines.push('', '```js', code.trimEnd(), '```', '');
  return lines.join('\n');
}
