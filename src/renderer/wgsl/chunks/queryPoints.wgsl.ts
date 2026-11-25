/** Query-point generation is independent of the host graphics API. Direct
 * callers keep function locals; resumable callers explicitly name the few
 * values that must survive a query. No generated source is inspected. */
export function queryState(enabled: boolean, type: string, instance: string, fields: Record<string, string>, addressable = false) {
  const owner = addressable ? `${instance}[(rtUniform.loopUnrollGuard - 4u) & 1u]` : instance;
  const refs = Object.fromEntries(Object.keys(fields).map(name => [name, enabled ? `${owner}.${name}` : name]));
  return {
    refs,
    declarations: enabled ? /* wgsl */ `struct ${type} { ${Object.entries(fields).map(([name, field]) => /* wgsl */ `${name}: ${field},`).join('\n')} };
var<private> ${instance}: ${addressable ? `array<${type}, 2>` : type};
` : '',
    init(name: string, value: string, immutable: boolean, typed: boolean) {
      return enabled ? /* wgsl */ `${refs[name]} = ${value};` : /* wgsl */ `${immutable ? 'let' : 'var'} ${refs[name]}${typed ? `: ${fields[name]}` : ''} = ${value};`;
    }
  };
}

/** One outstanding query per invocation. Sequential random continuation draws
 * wait for visibility; structured draws may finish earlier. Bevel stays direct. */
export function pendingSceneQueryRef(addressable = false) {
  return addressable ? 'pendingSceneQuery[(rtUniform.loopUnrollGuard - 4u) & 1u]' : 'pendingSceneQuery';
}

export function createQueryPointsWgsl(addressable = false, radianceOutputs = false) {
  const pendingQuery = pendingSceneQueryRef(addressable);
  return /* wgsl */ `
struct PendingSceneQuery {
  ray: Ray,
  maximum: f32,
  triangle: i32,
  instance: i32,
  kind: i32,
  pending: bool,
  occluded: bool,
  contribution: vec3f,
${radianceOutputs ? '  radianceSpecular: vec3f,\n' : ''}  weight: f32,
};
var<private> pendingSceneQuery: ${addressable ? 'array<PendingSceneQuery, 2>' : 'PendingSceneQuery'};

fn requestSceneVisibility(ray: Ray, maximum: f32, triangle: i32, instance: i32, kind: i32) {
  ${pendingQuery}.ray = ray;
  ${pendingQuery}.maximum = maximum;
  ${pendingQuery}.triangle = triangle;
  ${pendingQuery}.instance = instance;
  ${pendingQuery}.kind = kind;
  ${pendingQuery}.pending = true;
${radianceOutputs ? `  ${pendingQuery}.radianceSpecular = vec3f(0.0);\n` : ''}}
`;
}

export const queryPointsWgsl = createQueryPointsWgsl();
