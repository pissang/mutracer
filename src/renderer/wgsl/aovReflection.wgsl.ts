// Center-ray records for the offline window. The previous rigid transforms and
// stable identities come from the same AOV metadata as surface motion.
export function aovReflectionWgsl(hasCoatNormals: boolean) {
  return /* wgsl */ `
// Tangent-plane image construction from MuTracer's DLSS integration (ec0f0c3c).
fn reflectionImage(point: vec3f, normal: vec3f, endpoint: vec3f) -> vec3f {
  return endpoint - 2.0 * dot(endpoint - point, normal) * normal;
}

fn reflectionNormal(transform: mat4x4f, normal: vec3f) -> vec3f {
  let a = transform[0].xyz; let b = transform[1].xyz; let c = transform[2].xyz;
  return normalize(mat3x3f(cross(b,c),cross(c,a),cross(a,b)) * normal / dot(a,cross(b,c)));
}

fn reflectionProjection(clip: vec4f, size: vec2u) -> vec2f {
  return clip.xy / clip.w * vec2f(size) * vec2f(0.5,-0.5);
}

fn traceReflection(
  pixel: vec2u, size: vec2u, ray: Ray, si: SurfaceInteraction,
  material: OpenPbrResolvedMaterial, surfaceOffset: u32
) -> AovCenter {
  var record = AovCenter(vec4u(0u), vec4f(1e20));
  let coat = clamp(material.coatWeight * (1.0 - material.coatRoughness), 0.0, 1.0);
  let roughness = clamp(mix(material.specularRoughness, material.coatRoughness, coat), 0.0, 1.0);
  var n = si.normal;
${hasCoatNormals ? `  if (material.coatNormalEnabled) { n = normalize(mix(n, coat_frame_normal(si.coatNormal, si.faceNormal, -ray.d), coat)); }` : ''}
  let face = faceForward(si.faceNormal, ray.d, si.faceNormal);
  if (dot(n, -ray.d) <= 0.0) { n = face; }
  let cosine = max(dot(n, -ray.d), 0.0);
  record.identity.w = pack2x16float(vec2f(roughness, cosine));
  if (material.materialType != STANDARD || material.alpha < 0.999 || cosine == 0.0) {
    record.identity.w = pack2x16float(vec2f(1.0, 0.0));
    return record;
  }

  let direction = reflect(ray.d, n);
  if (dot(direction, face) <= 0.0) { return record; }
  var bounce: Ray;
  initRay(&bounce, offsetSurfaceRay(si.position, face, direction, ray.o), direction);
  var hit: SurfaceInteraction; var reflectedMaterial: OpenPbrResolvedMaterial;
  let finiteHit = aovSurface(bounce, &hit, &reflectedMaterial);
  var endpoint = vec4f(direction, 0.0);
  var priorEndpoint = endpoint;
  var distanceToHit = -1.0;
  var endpointValid = true;
  if (finiteHit) {
    let offset = 52u + u32(hit.instanceIndex) * 24u;
    distanceToHit = distance(si.position, hit.position);
    record.identity = vec4u(aovScene[offset], aovScene[offset+1u], 0u, record.identity.w);
    endpoint = vec4f(hit.position, 1.0);
    endpointValid = aovScene[offset+2u] != 0u && aovScene[offset+3u] == 0u;
    if (endpointValid) { priorEndpoint = aovMatrix(offset+4u) * endpoint; }
  } else {
    record.identity = vec4u(vec2u(0xffffffffu), 0u, record.identity.w);
  }
  record.identity.z = bitcast<u32>(distanceToHit);
  // Record the current endpoint at cuts as well, for forward inversion.
  if (aovScene[surfaceOffset+2u] == 0u || aovScene[surfaceOffset+3u] != 0u || !endpointValid) {
    return record;
  }
  let transform = aovMatrix(surfaceOffset+4u);
  let previousPoint = (transform * vec4f(si.position, 1.0)).xyz;
  let previousNormal = reflectionNormal(transform, n);
  let vp = aovMatrix(0u);
  let image = select(reflect(priorEndpoint.xyz, previousNormal),
    reflectionImage(previousPoint, previousNormal, priorEndpoint.xyz), finiteHit);
  let previous = vp * vec4f(image, endpoint.w);
  let surface = vp * vec4f(previousPoint, 1.0);
  if (!(previous.w > 1e-6 && surface.w > 1e-6)) { return record; }
  // Frame textures are top-first. NDC projection above already flips Y.
  let center = (vec2f(pixel)+0.5-0.5*vec2f(size)) * vec2f(1.0,-1.0);
  let projected = reflectionProjection(previous, size);
  let planar = projected-center;
  if (!all(abs(planar) < vec2f(size))) { return record; }
  record.motion = vec4f(planar, vec2f(1e20));
  return record;
}
`;
}
