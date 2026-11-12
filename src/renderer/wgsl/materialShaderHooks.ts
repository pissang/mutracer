/** Internal shader-generation inputs shared by browser and native AOT.
 * Templates own the flag word and all material/shadow function boundaries. */
export interface MaterialShaderHooks {
  graph?: {declarations: string; evaluate: string; opacity: boolean; emission?: boolean};
  materialXNormals?: boolean;
}

/** Explicit call site, including post-transform normal sampling. */
export function materialCall(ma: string, si: string, hooks: MaterialShaderHooks = {}, compact = false) {
  const separator = compact ? ',' : ', ';
  const args = [ma, `${si}.materialIndex`, `${si}.uv`, `${si}.uv1`, `${si}.instanceIndex`, `${si}.vertexColor`];
  let source = hooks.graph ? `${si}.normal = ` : '';
  if (hooks.graph) args.push(si);
  source += `getMaterial(${args.join(separator)});`;
  if (hooks.materialXNormals) source += `\nmaterialx_normal(${si === '(*si)' ? 'si' : `&${si}`});`;
  return source;
}
