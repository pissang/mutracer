import { Matrix4, Vector3, MathUtils } from 'three';
import { PbrtError, type Parameter, type Statement } from './parser';
import { walk, type Resolver, type Resource, type Warning } from './source';
export type Params = Record<string, Parameter>;
export interface Entity { type: string; params: Params; loc: Statement; reference?: string }
export interface PlacedEntity extends Entity { transform: number[] }
export interface Shape extends PlacedEntity { material: Entity; areaLight?: Entity; reverse: boolean; inside: string; outside: string }
export interface Instance { name: string; transform: number[]; loc: Statement }
export interface Scene {
  entry: string; shapes: Shape[]; instances: Instance[]; objects: Record<string, Shape[]>;
  materials: Record<string, Entity>; textures: Record<string, PlacedEntity>; media: Record<string, Entity>;
  lights: PlacedEntity[]; camera?: PlacedEntity; cameraMedium: string;
  film?: Entity; sampler?: Entity; integrator?: Entity; resources: Resource[]; warnings: Warning[];
}
interface State {
  transform: Matrix4; material: Entity; areaLight?: Entity; reverse: boolean; inside: string; outside: string;
  active: boolean; defaults: Record<string, Params>;
}
export const first = (p: Params, key: string, fallback: string | number | boolean) => p[key]?.values[0] ?? fallback;
export const scalar = (p: Params, key: string, fallback: number) => Number(first(p, key, fallback));
export const vector = (p: Params, key: string, fallback: number[]) => p[key] ? Array.from(p[key].values, Number) : fallback;
const clone = (state: State): State => ({ ...state, transform: state.transform.clone(), defaults: { ...state.defaults } });

export async function buildScene(entry: string, resolver: Resolver): Promise<Scene> {
  const scene: Scene = { entry, shapes: [], instances: [], objects: Object.create(null), materials: Object.create(null), textures: Object.create(null), media: Object.create(null), lights: [], cameraMedium: '', resources: [], warnings: [] };
  let state: State = { transform: new Matrix4(), material: { type: 'diffuse', params: {}, loc: { file: entry, line: 1, column: 1, kind: 'Material', args: [], params: {} } }, reverse: false, inside: '', outside: '', active: true, defaults: {} };
  const coordinates = new Map<string, Matrix4>();
  const stack: { kind: string; state: State; loc: Statement }[] = [];
  const imports: { state: State; depth: number; coordinates: Map<string, Matrix4> }[] = [];
  let object: string | undefined, world = false;
  const resources = new Map<string, Resource>();
  const warningGroups = new Map<string, Warning>();
  const warning = (s: Statement, handling: string, code = 'ignored') => {
    const key = `${s.file}:${s.kind}:${handling}`, previous = warningGroups.get(key);
    if (previous) { previous.count = (previous.count ?? 1) + 1; previous.lastLine = s.line; }
    else { const value = { statement: s.kind, file: s.file, line: s.line, code, handling }; warningGroups.set(key, value); scene.warnings.push(value); }
  };
  const entity = (s: Statement, type = String(s.args[0])): Entity => ({ type, params: { ...state.defaults[({ MakeNamedMaterial: 'material', MakeNamedMedium: 'medium', LightSource: 'light', AreaLightSource: 'light' } as Record<string, string>)[s.kind] ?? s.kind.toLowerCase()], ...s.params }, loc: s });
  const placed = (s: Statement): PlacedEntity => ({ ...entity(s), transform: state.transform.toArray() });
  const push = (kind: string, loc: Statement) => stack.push({ kind, state: clone(state), loc });
  const pop = (kind: string, loc: Statement) => {
    const frame = stack.pop();
    if (!frame || frame.kind !== kind || imports.length && stack.length < imports[imports.length - 1].depth) throw new PbrtError(`Unmatched ${loc.kind}`, loc);
    state = frame.state;
  };
  for await (const s of walk(entry, resolver, resources)) {
    const args = s.args.map(Number);
    switch (s.kind) {
      case 'Include': break;
      case 'Import':
        if (!world) throw new PbrtError('Import requires WorldBegin', s);
        imports.push({ state: clone(state), depth: stack.length, coordinates: new Map(coordinates) }); break;
      case 'ImportEnd': {
        const imported = imports.pop()!;
        if (stack.length !== imported.depth) throw new PbrtError('Unclosed block inside Import', s);
        state = imported.state; coordinates.clear(); for (const [name, matrix] of imported.coordinates) coordinates.set(name, matrix); break;
      }
      case 'WorldBegin':
        if (world) throw new PbrtError('Duplicate WorldBegin', s);
        world = true; state.transform.identity(); state.active = true; coordinates.set('world', new Matrix4()); break;
      case 'WorldEnd': warning(s, 'Deprecated WorldEnd has no effect'); break;
      case 'AttributeBegin': push('attribute', s); break;
      case 'AttributeEnd': pop('attribute', s); break;
      case 'TransformBegin': push('attribute', s); warning(s, 'Deprecated TransformBegin uses AttributeBegin semantics'); break;
      case 'TransformEnd': pop('attribute', s); warning(s, 'Deprecated TransformEnd uses AttributeEnd semantics'); break;
      case 'Attribute': {
        const target = String(s.args[0]); state.defaults[target] = { ...state.defaults[target], ...s.params }; break;
      }
      case 'ReverseOrientation': state.reverse = !state.reverse; break;
      case 'ActiveTransform':
        if (!['All', 'StartTime', 'EndTime'].includes(String(s.args[0]))) throw new PbrtError('Invalid ActiveTransform', s);
        state.active = s.args[0] !== 'EndTime'; warning(s, 'Uses the start transform; no motion blur', 'motion'); break;
      case 'TransformTimes': warning(s, 'Uses the start transform; no motion blur', 'motion'); break;
      case 'CoordinateSystem': coordinates.set(String(s.args[0]), state.transform.clone()); break;
      case 'CoordSysTransform': {
        const matrix = coordinates.get(String(s.args[0]));
        if (!matrix) { warning(s, `Undefined coordinate system ${s.args[0]}; keeps current transform`); break; }
        if (state.active) state.transform.copy(matrix); break;
      }
      case 'Identity': if (state.active) state.transform.identity(); break;
      case 'Transform': if (state.active) state.transform.fromArray(args); break;
      case 'ConcatTransform': if (state.active) state.transform.multiply(new Matrix4().fromArray(args)); break;
      case 'Translate': if (state.active) state.transform.multiply(new Matrix4().makeTranslation(args[0], args[1], args[2])); break;
      case 'Scale': if (state.active) state.transform.multiply(new Matrix4().makeScale(args[0], args[1], args[2])); break;
      case 'Rotate': {
        const axis = new Vector3(args[1], args[2], args[3]);
        if (axis.lengthSq() === 0) throw new PbrtError('Rotation axis is zero', s);
        if (state.active) state.transform.multiply(new Matrix4().makeRotationAxis(axis.normalize(), MathUtils.degToRad(args[0]))); break;
      }
      case 'LookAt': {
        const eye = new Vector3(...args.slice(0, 3) as [number, number, number]);
        const direction = new Vector3(...args.slice(3, 6) as [number, number, number]).sub(eye).normalize();
        const up = new Vector3(...args.slice(6, 9) as [number, number, number]).normalize();
        const right = new Vector3().crossVectors(up, direction).normalize();
        if (direction.lengthSq() === 0 || right.lengthSq() === 0) throw new PbrtError('Degenerate LookAt', s);
        const cameraToWorld = new Matrix4().makeBasis(right, new Vector3().crossVectors(direction, right), direction).setPosition(eye);
        if (state.active) state.transform.multiply(cameraToWorld.invert()); break;
      }
      case 'Camera': {
        scene.camera = placed(s); scene.camera.transform = state.transform.clone().invert().toArray(); scene.cameraMedium = state.outside;
        coordinates.set('camera', new Matrix4().fromArray(scene.camera.transform)); break;
      }
      case 'Film': scene.film = entity(s); break;
      case 'Sampler': scene.sampler = entity(s); break;
      case 'Integrator': scene.integrator = entity(s); break;
      case 'Material': state.material = entity(s); break;
      case 'MakeNamedMaterial': scene.materials[String(s.args[0])] = entity(s, String(first(s.params, 'type', 'diffuse'))); break;
      case 'NamedMaterial': state.material = { type: 'named', reference: String(s.args[0]), params: {}, loc: s }; break;
      case 'Texture': { const texture = { ...placed(s), type: String(s.args[2]) }; scene.textures[String(s.args[0])] = texture; scene.textures[`${s.args[1]}:${s.args[0]}`] = texture; break; }
      case 'MakeNamedMedium': scene.media[String(s.args[0])] = entity(s, String(first(s.params, 'type', 'homogeneous'))); break;
      case 'MediumInterface': state.inside = String(s.args[0]); state.outside = String(s.args[1]); break;
      case 'AreaLightSource': state.areaLight = s.args[0] ? entity(s) : undefined; break;
      case 'LightSource': scene.lights.push(placed(s)); break;
      case 'Shape': {
        if (!world) throw new PbrtError('Shape requires WorldBegin', s);
        if (s.args[0] === 'curve') { warning(s, 'Curve skipped', 'shape'); break; }
        const shape: Shape = { ...placed(s), material: state.material, areaLight: state.areaLight, reverse: state.reverse, inside: state.inside, outside: state.outside };
        (object ? scene.objects[object] : scene.shapes).push(shape); break;
      }
      case 'ObjectBegin': {
        if (object) throw new PbrtError('Nested ObjectBegin', s);
        const name = String(s.args[0]);
        if (scene.objects[name]) throw new PbrtError(`Duplicate object ${name}`, s);
        object = name; scene.objects[name] = []; push('object', s); break;
      }
      case 'ObjectEnd': if (!object) throw new PbrtError('Unmatched ObjectEnd', s); pop('object', s); object = undefined; break;
      case 'ObjectInstance':
        if (object) throw new PbrtError('Nested ObjectInstance is not supported by PBRT-v4', s);
        scene.instances.push({ name: String(s.args[0]), transform: state.transform.toArray(), loc: s }); break;
      case 'ColorSpace': if (s.args[0] !== 'srgb') warning(s, `Color space ${s.args[0]} interpreted as sRGB`, 'color-space'); break;
      case 'Option': warning(s, 'Renderer option ignored'); break;
      case 'PixelFilter': warning(s, 'Uses MuTracer pixel filter'); break;
      case 'Accelerator': warning(s, 'Uses MuTracer BVH'); break;
      default: warning(s, 'Statement ignored');
    }
  }
  if (stack.length) throw new PbrtError(`Unclosed ${stack[stack.length - 1].loc.kind}`, stack[stack.length - 1].loc);
  for (const instance of scene.instances) if (!scene.objects[instance.name]) throw new PbrtError(`Undefined object ${instance.name}`, instance.loc);
  for (const shape of [...scene.shapes, ...Object.values(scene.objects).flat()]) if (shape.material.reference !== undefined) {
    const named = scene.materials[shape.material.reference];
    if (!named) throw new PbrtError(`Undefined material ${shape.material.reference}`, shape.material.loc);
    shape.material = named;
  }
  scene.resources = [...resources.values()];
  return scene;
}
