import {Camera, Engine, Render, Mesh, OpenPBRMaterial, RectLight, SphereLight, DirectionalLight, createPlaneGeometry, createSphereGeometry} from '../../src/main.js';
import {causticCasterSphere, causticCasterSpheres} from '../../src/renderer/caustics.js';

/** Small procedural room; distant and hidden casters deliberately share one emitter. */
export async function captureScale(variant: string, study: (engine: Engine, render: Render) => Promise<unknown>) {
  const canvas = document.createElement('canvas');
  const engine = new Engine({canvas, backend: 'webgpu', textureBinding: 'atlas'});
  const render = new Render(engine, {bounces: 8, bevel: false});
  try {
    const info = await engine.init();
    const [width, height] = (window as any).causticSize ?? [256, 256];
    engine.display.setSize(width, height);
    const camera = new Camera({projection: 'perspective', fov: 50, aspect: width / height});
    camera.position = [3, 2.6, 4]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const scale = variant === 'room10' ? 10 : variant === 'room100' ? 100 : 1;
    const diffuse = new OpenPBRMaterial({baseColor: [.6, .6, .6]});
    const floor = new Mesh(createPlaneGeometry(), diffuse);
    floor.transform[0] = floor.transform[10] = variant === 'many' || variant === 'offscreen' || variant.includes('offset') ? 20 : 6 * scale;
    const wall = new Mesh(createPlaneGeometry(1, 1, 'vertical'), diffuse);
    wall.position = [0, 3 * scale, -3 * scale]; wall.transform[0] = variant === 'many' ? 6 : 3 * scale; wall.transform[5] = 3 * scale;
    const glass = new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0, specularIor: 1.5});
    const geometry = createSphereGeometry(32, 16);
    const sphere = (position: [number, number, number], radius: number) => {
      const mesh = new Mesh(geometry, glass); mesh.position = position;
      mesh.transform[0] = mesh.transform[5] = mesh.transform[10] = radius; return mesh;
    };
    const meshes = [floor, wall, sphere([0, .85, 0], .8)];
    if (variant === 'many') for (let i = 0; i < 19; i++) meshes.push(sphere([-12 + i % 5 * 5, .5, -7 - Math.floor(i / 5) * 4], .5));
    if (variant === 'offscreen' || variant.includes('offset')) meshes.push(sphere([8, 5, 10], 4));
    const point = new SphereLight({intensity: 120 * scale * scale, radius: 0});
    point.position = [-1.5 * scale, 3 * scale, 0];
    const weak = new SphereLight({intensity: 12, radius: 0}); weak.position = [1.5, 3, .5];
    const area = new RectLight({intensity: 8, size: [2, 2]}); area.position = [1.5, 3, .5]; area.lookAt([0, 0, 0]);
    if (variant === 'collimated') area.spread=0;
    const sun = new DirectionalLight({intensity: 3}); sun.position = [1, 3, 1]; sun.lookAt([0, 0, 0]);
    const lights = variant.startsWith('two-points') ? [point, weak] : variant === 'collimated' ? [area] : variant.startsWith('mixed') ? [point, area] : variant.startsWith('sun-point') ? [point, sun] : [point];
    if (variant.endsWith('-first')) lights.splice(1);
    if (variant.endsWith('-second')) lights.splice(0, 1);
    engine.scene = {meshes, lights, background: [0, 0, 0, 1]}; engine.update();
    const spheres = causticCasterSpheres(meshes), bounds = causticCasterSphere(meshes);
    const audit = {variant, adapter: info.adapterName, width, height, spheres, bounds, initialRadius: bounds[3] * .03,
      individualRadii: spheres.map(s => s[3] * .03), receivers: [floor, wall].map(m => ({transform: Array.from(m.transform)})), camera: {projection: camera.projection, transform: Array.from(camera.transform), fov: camera.fov, aspect: camera.aspect},
      lights: lights.map(l => ({type: l.type, intensity: l.intensity, position: l.position}))};
    await fetch('/__evidence/' + variant + '-scene.json', {method: 'POST', body: JSON.stringify(audit, null, 2)});
    return await study(engine, render);
  } finally {render.dispose(); engine.dispose();}
}
