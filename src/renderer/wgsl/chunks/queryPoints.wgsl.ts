/** Query-point generation is independent of the host graphics API. Direct
 * callers keep function locals; resumable callers explicitly name the few
 * values that must survive a query. No generated source is inspected. */
export function queryState<T extends Record<string, string>>(enabled: boolean, type: string, instance: string, fields: T, addressable = false) {
  const owner = addressable ? `${instance}[(rtUniform.loopUnrollGuard - 4u) & 1u]` : instance;
  const refs = Object.fromEntries(Object.keys(fields).map(name => [name, enabled ? `${owner}.${name}` : name])) as Record<keyof T, string>;
  return {
    refs,
    declarations: enabled ? /* wgsl */ `struct ${type} { ${Object.entries(fields).map(([name, field]) => /* wgsl */ `${name}: ${field},`).join('\n')} };
var<private> ${instance}: ${addressable ? `array<${type}, 2>` : type};
` : '',
    init(name: keyof T, value: string, immutable = false, typed = false) {
      return enabled ? /* wgsl */ `${refs[name]} = ${value};` : /* wgsl */ `${immutable ? 'let' : 'var'} ${refs[name]}${typed ? `: ${fields[name]}` : ''} = ${value};`;
    }
  };
}

/** One outstanding query per invocation. A shadow query resumes its caller
 * before any continuation random draw. Bevel retains its direct traversal. */
export const queryPointsWgsl = /* wgsl */ `
struct PendingSceneQuery {
  ray: Ray,
  maximum: f32,
  triangle: i32,
  instance: i32,
  kind: i32,
  pending: bool,
  occluded: bool,
  contribution: vec3f,
  weight: f32,
};
var<private> pendingSceneQuery: PendingSceneQuery;

fn requestSceneVisibility(ray: Ray, maximum: f32, triangle: i32, instance: i32, kind: i32) {
  pendingSceneQuery.ray = ray;
  pendingSceneQuery.maximum = maximum;
  pendingSceneQuery.triangle = triangle;
  pendingSceneQuery.instance = instance;
  pendingSceneQuery.kind = kind;
  pendingSceneQuery.pending = true;
}
`;
