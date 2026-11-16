import * as THREE from 'three';

/** Outline width in CSS pixels. */
const WIDTH = 2.5;
/** Bright orange that stands out from most materials and the gray workspace. */
const COLOR = '#ffa22e';
/** Opacity of the visible outline and of the parts behind other objects. */
const VISIBLE_ALPHA = 1, HIDDEN_ALPHA = 0.4;
/** Seconds to fade out when editing starts and back in once it stops. */
const FADE_OUT = 0.08, FADE_IN = 0.25;
/** Seconds the outline stays hidden after the last edit. */
const SETTLE = 0.5;

interface Proxy { source: THREE.Mesh; mesh: THREE.Mesh; geometry: THREE.BufferGeometry }

/**
 * Silhouette outline of one object, drawn on a transparent WebGL canvas above
 * the path traced image. The traced canvas stays untouched, so exports and
 * accumulation never see the outline. The other meshes under `root` are
 * rasterized for depth only, so edges behind them draw fainter.
 */
export class SelectionOutline {
  private readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  /** Occluders write depth only. */
  private readonly depth = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  /** Red: the selection where nothing covers it. */
  private readonly front = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide, depthWrite: false, depthFunc: THREE.LessEqualDepth });
  /** Green: the whole silhouette, added to the red pass. */
  private readonly whole = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  private target: THREE.WebGLRenderTarget | null = null;
  private quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly proxies = new Map<THREE.Mesh, Proxy>();
  private readonly selected = new Set<THREE.Mesh>();
  private object: THREE.Object3D | null = null;
  private opacity = 0;
  private hiddenFor = 0;
  private lastKey = 0;
  private failed = false;

  constructor(private readonly reference: HTMLCanvasElement, private readonly root: THREE.Object3D) {
    this.canvas.className = 'viewport__canvas viewport__outline';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.scene.matrixWorldAutoUpdate = false;
    reference.after(this.canvas);
  }

  /**
   * Draws the outline of `object` (or hides it for null). Returns false when
   * the object has no geometry available on this side, so the caller can fall
   * back to another indicator.
   */
  update(object: THREE.Object3D | null, camera: THREE.Camera, editing: boolean, dt: number): boolean {
    if (object !== this.object) {
      this.object = object;
      this.opacity = 0;
      this.hiddenFor = 0;
      this.lastKey = 0;
      this.selected.clear();
      object?.traverse((child) => { if (hasPositions(child)) this.selected.add(child); });
    }
    if (!object) { this.hide(); return true; }
    if (!this.selected.size || this.failed) { this.hide(); return false; }

    this.hiddenFor = editing ? SETTLE : Math.max(0, this.hiddenFor - dt);
    const goal = this.hiddenFor > 0 ? 0 : 1;
    const rate = dt / (goal > this.opacity ? FADE_IN : FADE_OUT);
    this.opacity = goal > this.opacity ? Math.min(goal, this.opacity + rate) : Math.max(goal, this.opacity - rate);
    if (this.opacity === 0) { this.hide(); return true; }

    const renderer = this.ensureRenderer();
    if (!renderer) return false;
    this.matchReference();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.reference.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.reference.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      renderer.setSize(width, height, false);
      this.target!.setSize(width, height);
    }

    this.root.updateWorldMatrix(true, true);
    object.updateWorldMatrix(true, true);
    const key = new Hash().add(width).add(height).add(this.opacity).matrix(camera.matrixWorld).matrix(camera.projectionMatrix);
    if (!this.syncProxies(key)) { this.hide(); return true; }
    this.canvas.style.visibility = '';
    if (key.value === this.lastKey) return true;
    this.lastKey = key.value;

    const uniforms = this.quad!.material.uniforms;
    uniforms.texel.value.set(1 / width, 1 / height);
    uniforms.radius.value = WIDTH * dpr;
    uniforms.opacity.value = this.opacity;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    this.renderPass(renderer, camera, this.depth, false);
    this.renderPass(renderer, camera, this.front, true);
    this.renderPass(renderer, camera, this.whole, true);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.quad!, this.quadCamera);
    return true;
  }

  dispose() {
    for (const proxy of this.proxies.values()) proxy.geometry.dispose();
    this.proxies.clear();
    this.target?.dispose();
    this.quad?.geometry.dispose();
    this.quad?.material.dispose();
    this.depth.dispose(); this.front.dispose(); this.whole.dispose();
    this.renderer?.dispose();
    this.canvas.remove();
  }

  private renderPass(renderer: THREE.WebGLRenderer, camera: THREE.Camera, material: THREE.Material, selected: boolean) {
    for (const proxy of this.proxies.values()) {
      proxy.mesh.visible = this.selected.has(proxy.source) === selected && proxy.mesh.userData.shown;
    }
    this.scene.overrideMaterial = material;
    renderer.render(this.scene, camera);
  }

  /**
   * Mirrors the meshes under the root and their transforms into the overlay
   * scene. Returns whether any part of the selection is visible.
   */
  private syncProxies(key: Hash) {
    const seen = new Set<THREE.Mesh>();
    let selectionShown = false;
    const visit = (object: THREE.Object3D) => {
      if (!object.visible) return;
      if (hasPositions(object)) {
        seen.add(object);
        let proxy = this.proxies.get(object);
        if (!proxy) {
          proxy = createProxy(object);
          this.proxies.set(object, proxy);
          this.scene.add(proxy.mesh);
        }
        proxy.mesh.userData.shown = true;
        proxy.mesh.matrix.copy(object.matrixWorld);
        proxy.mesh.matrixWorld.copy(object.matrixWorld);
        key.matrix(object.matrixWorld);
        // Deformed meshes can change without a transform change.
        if ((object as THREE.SkinnedMesh).isSkinnedMesh || object.morphTargetInfluences?.length) key.add(performance.now());
        if (this.selected.has(object)) selectionShown = true;
      }
      for (const child of object.children) visit(child);
    };
    visit(this.root);
    for (const [source, proxy] of this.proxies) {
      if (seen.has(source)) continue;
      // Kept while hidden; released once the mesh leaves the model.
      proxy.mesh.userData.shown = false;
      if (isAttached(source, this.root)) continue;
      this.scene.remove(proxy.mesh);
      // Releases only this renderer's copies; the attributes stay shared.
      proxy.geometry.dispose();
      this.proxies.delete(source);
    }
    key.add(seen.size);
    return selectionShown;
  }

  private hide() {
    if (this.canvas.style.visibility !== 'hidden') this.canvas.style.visibility = 'hidden';
    this.lastKey = 0;
  }

  private matchReference() {
    const from = this.reference.style, to = this.canvas.style;
    if (to.width !== from.width) to.width = from.width;
    if (to.height !== from.height) to.height = from.height;
    if (to.margin !== from.margin) to.margin = from.margin;
  }

  private ensureRenderer() {
    if (this.renderer) return this.renderer;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' });
    } catch {
      this.failed = true;
      return null;
    }
    this.renderer.autoClear = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: {
        mask: { value: this.target.texture },
        texel: { value: new THREE.Vector2() },
        radius: { value: WIDTH },
        opacity: { value: 0 },
        color: { value: new THREE.Color(COLOR) }
      },
      // Covers the line width at the largest device pixel ratio (2).
      defines: { REACH: Math.ceil(WIDTH * 2 + 0.5) },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      // Distances to the nearest silhouette and to the nearest unoccluded
      // selection pixel give an antialiased line that dims behind occluders.
      fragmentShader: /* glsl */`
        uniform sampler2D mask; uniform vec2 texel; uniform float radius; uniform float opacity; uniform vec3 color;
        varying vec2 vUv;
        void main() {
          if (texture2D(mask, vUv).g > 0.5) discard;
          float whole = 1e3, front = 1e3;
          for (int y = -REACH; y <= REACH; y++) for (int x = -REACH; x <= REACH; x++) {
            vec2 offset = vec2(x, y);
            float d = length(offset);
            if (d > radius + 0.5) continue;
            vec2 m = texture2D(mask, vUv + offset * texel).rg;
            if (m.g > 0.5) whole = min(whole, d);
            if (m.r > 0.5) front = min(front, d);
          }
          float shown = mix(${HIDDEN_ALPHA.toFixed(2)}, ${VISIBLE_ALPHA.toFixed(2)}, clamp(radius + 0.5 - front, 0.0, 1.0));
          float alpha = clamp(radius + 0.5 - whole, 0.0, 1.0) * opacity * shown;
          if (alpha <= 0.0) discard;
          gl_FragColor = vec4(color * alpha, alpha);
        }`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      premultipliedAlpha: true
    }));
    this.quad.frustumCulled = false;
    return this.renderer;
  }
}

/** A mesh that reuses only the attributes the mask needs. */
function createProxy(source: THREE.Mesh): Proxy {
  const from = source.geometry;
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(from.index);
  for (const name of ['position', 'skinIndex', 'skinWeight']) {
    const attribute = from.getAttribute(name);
    if (attribute) geometry.setAttribute(name, attribute);
  }
  if (from.morphAttributes.position) geometry.morphAttributes.position = from.morphAttributes.position;
  geometry.morphTargetsRelative = from.morphTargetsRelative;
  geometry.setDrawRange(from.drawRange.start, from.drawRange.count);

  let mesh: THREE.Mesh;
  const skinned = source as THREE.SkinnedMesh, instanced = source as THREE.InstancedMesh;
  if (skinned.isSkinnedMesh) {
    const proxy = new THREE.SkinnedMesh(geometry);
    proxy.bindMode = skinned.bindMode;
    proxy.bind(skinned.skeleton, skinned.bindMatrix);
    mesh = proxy;
  } else if (instanced.isInstancedMesh) {
    const proxy = new THREE.InstancedMesh(geometry, undefined, instanced.count);
    proxy.instanceMatrix = instanced.instanceMatrix;
    mesh = proxy;
  } else {
    mesh = new THREE.Mesh(geometry);
  }
  if (source.morphTargetInfluences) mesh.morphTargetInfluences = source.morphTargetInfluences;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  return { source, mesh, geometry };
}

function hasPositions(object: THREE.Object3D): object is THREE.Mesh {
  return !!(object as THREE.Mesh).isMesh && !!(object as THREE.Mesh).geometry?.getAttribute('position');
}

function isAttached(object: THREE.Object3D, root: THREE.Object3D) {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o === root) return true;
  return false;
}

/** FNV-1a over float bits; detects whether the overlay needs a redraw. */
class Hash {
  private static readonly view = new DataView(new ArrayBuffer(4));
  value = 0x811c9dc5;
  add(value: number) {
    Hash.view.setFloat32(0, value);
    this.value = Math.imul(this.value ^ Hash.view.getUint32(0), 0x01000193) >>> 0;
    return this;
  }
  matrix(matrix: THREE.Matrix4) {
    for (const value of matrix.elements) this.add(value);
    return this;
  }
}
