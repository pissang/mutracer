/** Internal shader-generation inputs shared by browser and native AOT.
 * Templates own the flag word and all material/shadow function boundaries. */
export interface MaterialShaderHooks {
  graph?: {declarations: string; evaluate: string; opacity: boolean; emission?: boolean; interpreter?: boolean;
    /** `getMaterialPrecomputed` body: graph results come from `mx_vertex`, the integrator's
     * single evaluation site for the surface and the NEE candidates' emission. */
    precomputed?: string};
  materialXNormals?: boolean;
}

/** Explicit call site, including post-transform normal sampling. */
export function materialCall(ma: string, si: string, hooks: MaterialShaderHooks = {}, compact = false, precomputed = false) {
  const separator = compact ? ',' : ', ';
  const args = [ma, `${si}.materialIndex`, `${si}.uv`, `${si}.uv1`, `${si}.instanceIndex`, `${si}.vertexColor`];
  let source = hooks.graph ? `${si}.normal = ` : '';
  if (hooks.graph) args.push(si);
  source += `${precomputed && hooks.graph?.precomputed !== undefined ? 'getMaterialPrecomputed' : 'getMaterial'}(${args.join(separator)});`;
  if (hooks.materialXNormals) source += `\n${materialXNormalCall(si)}`;
  return source;
}

/** Integrator vertex query: the ray query, the shared graph site and the material
 * load. `query` is a WGSL condition; `bounce` is the sampling bounce the vertex's
 * NEE will use, so the site can evaluate the candidates' graph emission; `nee` must
 * hold wherever this vertex reaches NEE (it may also hold elsewhere). Without
 * shared evaluation this is the plain query and material call. */
export function materialQuery(query: string, intersect: string, ma: string, si: string, bounce: string, hooks: MaterialShaderHooks = {}, nee = 'true') {
  if (hooks.graph?.precomputed === undefined) return `if (${query}) {\n      ${intersect}\n      ${materialCall(ma, si, hooks)}\n    }`;
  return `let mxQuery = ${query};\n    if (mxQuery) { ${intersect} }\n    mx_vertex(mxQuery, ${ma}, ${siPointer(si)}, ${bounce}, ${nee});${hooks.materialXNormals ? `\n    if (mxQuery) { ${materialXNormalCall(si)} }` : ''}`;
}
const siPointer = (si: string) => si === '(*si)' ? 'si' : `&${si}`;
const materialXNormalCall = (si: string) => `materialx_normal(${siPointer(si)});`;
