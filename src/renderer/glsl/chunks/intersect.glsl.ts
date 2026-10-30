import { mapAlphaUsageConstants } from '../../materialConstants.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { INSTANCE_VEC4_STRIDE } from '../../bvhAccel.js';
import { createShaderMixin, glsl, Shader } from '../../shader.js';

function getBVHTraverseCode(
  handleHitCode: string,
  skipTriangleCode = '',
  initialTMax = 'RAY_MAX_DISTANCE'
) {
  const intersectTriangles = glsl`
        ivec3 vertexOffset = ivec3(floatBitsToInt(fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE}).y));
        for (int k = 0; k < primitiveCount; k++) {
          int triangleIndex = primitiveOffset + k;
          ${skipTriangleCode}
          vec4 r3 = fetchBVH(triangleIndex);
          ivec3 index = floatBitsToInt(r3.xyz) + vertexOffset;
          Triangle tri = Triangle(
            fetchData(positionBuffer, index.x, vertexColumns).xyz,
            fetchData(positionBuffer, index.y, vertexColumns).xyz,
            fetchData(positionBuffer, index.z, vertexColumns).xyz
          );
          TriangleIntersect hit = intersectTriangle(o, d, tri, maxDim, shear, tMax);

          if (hit.t > 0.0) {
            tMax = hit.t;
            vec3 e1 = tri.p1 - tri.p0;
            vec3 e2 = tri.p2 - tri.p0;
            vec3 faceNormal = normalize(cross(e1, e2));
            int sideMaterialIndex = int(unpackMaterialIndex(
              floatBitsToInt(fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE}).z)
            ).x);
            bool materialDoubleSided = fetchMatData(
              sideMaterialIndex * MAT_DATA_SIZE + MAT_ROW_ALPHA
            ).z > 0.5;
            if (!doubleSided && !materialDoubleSided && dot(faceNormal, d) > 0.0) {
              continue;
            }

            ${handleHitCode}
          }
        }
`;
  return glsl`
  ivec2 stack[STACK_SIZE];
  int top = -1;
  int prevInsIdx = -1;
  float tMax = ${initialTMax};

  vec3 o = ray.o;
  vec3 d = ray.d;

  bool isHit = false;
  vec3 hitFaceNormal;
  vec3 hitBarycentric;
  ivec3 hitIndex;

  Triangle hitTri;

  // TODO not sure why. but do root node check here will cause rendering wrong in windows.
    top = 0;
    stack[0] = ivec2(0, -1);

  int iter = 0;
  while(top >= 0 && iter < 5000) {
    iter++;
    ivec2 node = stack[top--];

    int insIdx = node.y;

    if (insIdx != prevInsIdx) {
      if (insIdx < 0) {
        o = ray.o;
        d = ray.d;
      }
      else {
        mat4 w2l = mat4(
          fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE} + 1),
          fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE} + 2),
          fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE} + 3),
          fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE} + 4)
        );
        o = (w2l * vec4(ray.o, 1.0)).xyz;
        d = (w2l * vec4(ray.d, 0.0)).xyz;
      }
      maxDim = maxDimension(abs(d));
      shear = getShear(d, maxDim);
      prevInsIdx = insIdx;
    }

    int bufferOff = insIdx < 0 ? 0 : blasOffset;
    uint encodedBlasOffset = insIdx < 0 ? 0u : floatBitsToUint(fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE}).x);
    int blasLayout = int(encodedBlasOffset >> 30u);
    int blasInsOffset = int(encodedBlasOffset & 0x3fffffffu);
    int primitiveCount = 0;
    int primitiveOffset = 0;

    if (blasLayout == 3) {
      uint nodeInfo = uint(node.x);
      if ((nodeInfo & 0x80000000u) != 0u) {
        primitiveCount = int((nodeInfo >> 23u) & 0xffu);
        primitiveOffset = bufferOff + blasInsOffset + int(nodeInfo & 0x007fffffu);
      }
      else {
        int i = node.x + bufferOff;
        vec4 compressed0 = fetchBVH(i);
        vec4 compressed1 = fetchBVH(i + 1);
        vec4 compressed2 = fetchBVH(i + 2);
        vec4 compressed3 = fetchBVH(i + 3);
        vec4 compressed4 = fetchBVH(i + 4);
        uint header = floatBitsToUint(compressed0.w);
        int exponentX = int(header << 24u) >> 24;
        int exponentY = int((header >> 8u) << 24u) >> 24;
        int exponentZ = int((header >> 16u) << 24u) >> 24;
        vec3 quantizationScale = vec3(
          uintBitsToFloat(uint(exponentX + 127) << 23u),
          uintBitsToFloat(uint(exponentY + 127) << 23u),
          uintBitsToFloat(uint(exponentZ + 127) << 23u)
        );
        uint childBase = floatBitsToUint(compressed1.x);
        uint triangleBase = floatBitsToUint(compressed1.y);
        uint internalMask = header >> 24u;
        uint octant = (d.x < 0.0 ? 4u : 0u) |
          (d.y < 0.0 ? 2u : 0u) |
          (d.z < 0.0 ? 1u : 0u);
        uint quantizedWords[12] = uint[12](
          floatBitsToUint(compressed2.x), floatBitsToUint(compressed2.y),
          floatBitsToUint(compressed2.z), floatBitsToUint(compressed2.w),
          floatBitsToUint(compressed3.x), floatBitsToUint(compressed3.y),
          floatBitsToUint(compressed3.z), floatBitsToUint(compressed3.w),
          floatBitsToUint(compressed4.x), floatBitsToUint(compressed4.y),
          floatBitsToUint(compressed4.z), floatBitsToUint(compressed4.w)
        );

        for (int order = 7; order >= 0; order--) {
          uint slot = uint(order) ^ octant;
          uint metaWord = slot >= 4u
            ? floatBitsToUint(compressed1.w)
            : floatBitsToUint(compressed1.z);
          uint meta = (metaWord >> ((slot & 3u) * 8u)) & 0xffu;
          if (meta == 0u) continue;
          uint byteShift = (slot & 3u) * 8u;
          uint wordOffset = slot >> 2u;
          vec3 quantizedMin = vec3(
            float((quantizedWords[wordOffset] >> byteShift) & 0xffu),
            float((quantizedWords[2u + wordOffset] >> byteShift) & 0xffu),
            float((quantizedWords[4u + wordOffset] >> byteShift) & 0xffu)
          );
          vec3 quantizedMax = vec3(
            float((quantizedWords[6u + wordOffset] >> byteShift) & 0xffu),
            float((quantizedWords[8u + wordOffset] >> byteShift) & 0xffu),
            float((quantizedWords[10u + wordOffset] >> byteShift) & 0xffu)
          );
          vec3 childMin = compressed0.xyz + quantizedMin * quantizationScale;
          vec3 childMax = compressed0.xyz + quantizedMax * quantizationScale;
          if (intersectBox(o, d, childMin, childMax, tMax) <= 0.0) continue;
          uint localOffset = meta & 0x1fu;
          if (localOffset >= 24u) {
            uint precedingMask = internalMask & ((1u << slot) - 1u);
            uint internalIndex = childBase + countBvhBits(precedingMask);
            stack[++top] = ivec2(
              blasInsOffset + int(internalIndex * 5u), insIdx
            );
          }
          else {
            uint triangleCount = countBvhBits(meta >> 5u);
            uint primitiveAddress = triangleBase + localOffset;
            uint leafInfo = 0x80000000u |
              (triangleCount << 23u) |
              (primitiveAddress & 0x007fffffu);
            stack[++top] = ivec2(int(leafInfo), insIdx);
          }
        }
      }
    }
    else if (blasLayout == 2) {
      int i = node.x + bufferOff;
      vec4 gpu0 = fetchBVH(i);
      vec4 gpu1 = fetchBVH(i + 1);
      vec4 gpu2 = fetchBVH(i + 2);
      vec4 gpu3 = fetchBVH(i + 3);
      primitiveCount = int(floatBitsToUint(gpu2.w));
      if (primitiveCount > 0) {
        primitiveOffset = bufferOff + blasInsOffset + int(floatBitsToUint(gpu3.w));
      }
      else {
        int left = blasInsOffset + int(floatBitsToUint(gpu0.w) * 4u);
        int right = blasInsOffset + int(floatBitsToUint(gpu1.w) * 4u);
        float d0 = intersectBox(o, d, gpu0.xyz, gpu1.xyz, tMax);
        float d1 = intersectBox(o, d, gpu2.xyz, gpu3.xyz, tMax);
        if (d0 > d1) {
          if (d0 > 0.0) stack[++top] = ivec2(left, insIdx);
          if (d1 > 0.0) stack[++top] = ivec2(right, insIdx);
        }
        else {
          if (d1 > 0.0) stack[++top] = ivec2(right, insIdx);
          if (d0 > 0.0) stack[++top] = ivec2(left, insIdx);
        }
      }
    }
    else if (blasLayout == 1) {
      uint nodeInfo = uint(node.x);
      if ((nodeInfo & 0x80000000u) != 0u) {
        primitiveCount = int((nodeInfo >> 23u) & 0xffu);
        primitiveOffset = bufferOff + blasInsOffset + int(nodeInfo & 0x007fffffu);
      }
      else {
        int i = node.x + bufferOff;
        vec4 wide0 = fetchBVH(i);
        vec4 wide1 = fetchBVH(i + 1);
        vec4 wide2 = fetchBVH(i + 2);
        vec4 wide3 = fetchBVH(i + 3);
        vec3 nodeMin = wide0.xyz;
        vec3 nodeExtent = vec3(wide0.w, wide1.x, wide1.y);
        uint childInfos[4] = uint[4](
          floatBitsToUint(wide1.z), floatBitsToUint(wide1.w),
          floatBitsToUint(wide2.x), floatBitsToUint(wide2.y)
        );
        vec4 childMinX = unpackBvh4Bounds(floatBitsToUint(wide2.z));
        vec4 childMinY = unpackBvh4Bounds(floatBitsToUint(wide2.w));
        vec4 childMinZ = unpackBvh4Bounds(floatBitsToUint(wide3.x));
        vec4 childMaxX = unpackBvh4Bounds(floatBitsToUint(wide3.y));
        vec4 childMaxY = unpackBvh4Bounds(floatBitsToUint(wide3.z));
        vec4 childMaxZ = unpackBvh4Bounds(floatBitsToUint(wide3.w));
        vec3 invD = traversalInverse(d);
        vec3 padding = depthSlabPadding(invD, o);
        vec4 tx0 = (nodeMin.x + childMinX * nodeExtent.x - o.x) * invD.x;
        vec4 tx1 = (nodeMin.x + childMaxX * nodeExtent.x - o.x) * invD.x;
        vec4 ty0 = (nodeMin.y + childMinY * nodeExtent.y - o.y) * invD.y;
        vec4 ty1 = (nodeMin.y + childMaxY * nodeExtent.y - o.y) * invD.y;
        vec4 tz0 = (nodeMin.z + childMinZ * nodeExtent.z - o.z) * invD.z;
        vec4 tz1 = (nodeMin.z + childMaxZ * nodeExtent.z - o.z) * invD.z;
        vec4 tNear = max(max((min(tx0, tx1) - vec4(padding.x)), (min(ty0, ty1) - vec4(padding.y))), (min(tz0, tz1) - vec4(padding.z)));
        vec4 tFar = min(min((max(tx0, tx1) + vec4(padding.x)), (max(ty0, ty1) + vec4(padding.y))), (max(tz0, tz1) + vec4(padding.z)));
        vec4 distance = mix(tFar, tNear, greaterThan(tNear, vec4(0.0)));
        distance = mix(distance, vec4(-1.0), greaterThan(tNear, min(tFar, vec4(tMax))));
        float childDistances[4] = float[4](distance.x, distance.y, distance.z, distance.w);

        // Push far-to-near so that the closest child is popped first.
        for (int order = 0; order < 4; order++) {
          float farthestDistance = -1.0;
          int farthestChild = -1;
          for (int child = 0; child < 4; child++) {
            if (childInfos[child] != 0u && childDistances[child] > farthestDistance) {
              farthestDistance = childDistances[child];
              farthestChild = child;
            }
          }
          if (farthestChild >= 0 && farthestDistance > 0.0) {
            uint childInfo = childInfos[farthestChild];
            int childAddress = int(childInfo);
            if ((childInfo & 0x80000000u) == 0u) {
              childAddress += blasInsOffset;
            }
            stack[++top] = ivec2(childAddress, insIdx);
            childDistances[farthestChild] = -1.0;
          }
        }
      }
    }
    else {
      int i = node.x + bufferOff;
      vec4 r1 = fetchBVH(i);
      int pointerToRightOrNumPrims = floatBitsToInt(r1.w);

      if (pointerToRightOrNumPrims >= 0) {
        int left = node.x + 2;
        int right = pointerToRightOrNumPrims + blasInsOffset;

        float d0 = intersectBox(o, d, fetchBVH(left + bufferOff).xyz, fetchBVH(left + 1 + bufferOff).xyz, tMax);
        float d1 = intersectBox(o, d, fetchBVH(right + bufferOff).xyz, fetchBVH(right + 1 + bufferOff).xyz, tMax);
        if (d0 > d1) {
          if (d0 > 0.0) {
            stack[++top] = ivec2(left, insIdx);
          }
          if (d1 > 0.0) {
            stack[++top] = ivec2(right, insIdx);
          }
        }
        else {
          if (d1 > 0.0) {
            stack[++top] = ivec2(right, insIdx);
          }
          if (d0 > 0.0) {
            stack[++top] = ivec2(left, insIdx);
          }
        }
      }
      else {
        if (insIdx < 0) {
          for (int k = 0; k < -pointerToRightOrNumPrims; k++) {
            vec4 r3 = fetchBVH(i + 2 + k);
            stack[++top] = ivec2(floatBitsToInt(r3.y), floatBitsToInt(r3.x));
          }
        }
        else {
          primitiveCount = -pointerToRightOrNumPrims;
          primitiveOffset = i + 2;
        }
      }
    }
    if (primitiveCount > 0) {
      ${intersectTriangles}
    }
  }
`;
}

export default createShaderMixin({
  uniforms: {
    positionBuffer: Shader.uniform('sampler2D'),
    normalBuffer: Shader.uniform('sampler2D'),
    tangentBuffer: Shader.uniform('sampler2D'),
    uvBuffer: Shader.uniform('sampler2D'),
    uv1Buffer: Shader.uniform('sampler2D'),
    colorBuffer: Shader.uniform('sampler2D'),
    materialIndexBuffer: Shader.uniform('sampler2D'),

    bvhBuffer: Shader.uniform('sampler2D'),
    instancesBuffer: Shader.uniform('sampler2D'),

    bvhColumns: Shader.uniform('int', 1),
    vertexColumns: Shader.uniform('int', 1),

    instancesColumns: Shader.uniform('int', 1),

    blasOffset: Shader.uniform('int'),

    isEmptyScene: Shader.uniform('bool')
  },
  main: glsl`

struct Triangle {
  vec3 p0;
  vec3 p1;
  vec3 p2;
};
#ifdef NUM_LIGHTS
float intersectSphere(float rad, vec3 pos, Ray r) {
  vec3 op = pos - r.o;
  float eps = 0.001;
  float b = dot(op, r.d);
  float det = b * b - dot(op, op) + rad * rad;
  if (det < 0.0)
    return INF;

  det = sqrt(det);
  float t1 = b - det;
  if (t1 > eps)
    return t1;

  float t2 = b + det;
  if (t2 > eps)
    return t2;

  return INF;
}

float intersectRect(vec3 pos, vec3 u, vec3 v, vec3 n, Ray r) {
  float dt = dot(r.d, n);
  float t = (dot(n, pos) - dot(n, r.o)) / dt;

  if (t > EPS) {
    vec3 p = r.o + r.d * t;
    vec3 vi = p - pos;
    float a1 = dot(u / dot(u, u), vi);
    if (a1 >= 0.0 && a1 <= 1.0) {
      float a2 = dot(v / dot(v, v), vi);
      if (a2 >= 0.0 && a2 <= 1.0) {
        return t;
      }
    }
  }

  return INF;
}

float sphereSolidAnglePdf(vec3 origin, vec3 center, float radius) {
  float centerDistance = distance(origin, center);
  if (centerDistance <= radius) return INV4PI;
  float sinThetaMaxSquared = min(1.0, radius * radius / (centerDistance * centerDistance));
  float cosThetaMax = sqrt(max(0.0, 1.0 - sinThetaMaxSquared));
  // Match the cancellation-free solid angle used by direct light sampling.
  float oneMinusCosThetaMax = sinThetaMaxSquared / (1.0 + cosThetaMax);
  return 1.0 / max(TWOPI * oneMinusCosThetaMax, 1e-8);
}

float intersectLight(Ray r, Light light, out LightSampleRec lightSample) {
  // Directional lights are delta sources without finite geometry. Start at
  // INF so they cannot accidentally terminate a BSDF continuation as a
  // geometric light hit; rect and sphere branches overwrite this value.
  float d = INF;
  vec3 u = light.u;
  vec3 v = light.v;
  int type = int(light.type);

#ifdef HAS_RECT_LIGHTS
  if (type == RECT_LIGHT) {
    // Adjust the position from center to start corner
    vec3 pos = light.position-u*0.5-v*0.5;
    vec3 normal = normalize(cross(u, v));
    if (dot(normal, r.d) > 0.) // Hide backfacing quad light
      return INF;

    d = intersectRect(pos, u, v, normal, r);
    if (d < 0.) {
      d = INF;
    }
    else {
      float cosTheta = dot(-r.d, normal);
      float spread = light.spread;
      if (cosTheta >= cos(spread * PI / 2.0)) {
        lightSample.pdf = (d * d) / (light.area * cosTheta);
        lightSample.emission = light.emission;
      }
    }
  }
#endif
#ifdef HAS_SPHERE_LIGHTS
  if (type == SPHERE_LIGHT) {
    if (light.radius <= 0.0) {
      vec3 toPoint = light.position - r.o;
      float projection = dot(toPoint, r.d);
      vec3 perpendicular = toPoint - projection * r.d;
      if (projection <= EPS || dot(perpendicular, perpendicular) > 1e-8) return INF;
      d = projection;
      lightSample.direction = r.d;
      lightSample.normal = -r.d;
      lightSample.dist = d;
      lightSample.pdf = 1.0;
      lightSample.isDelta = true;
    } else {
      d = intersectSphere(light.radius, light.position, r);
      lightSample.isDelta = false;
    }
    if (d < 0.) {
      d = INF;
    }
    else {
      if (light.radius > 0.0) {
        lightSample.pdf = sphereSolidAnglePdf(r.o, light.position, light.radius);
      }
      lightSample.emission = light.radius <= 0.0
        ? light.emission / max(d * d, 1e-8)
        : light.emission;
    }
  }
#endif
#ifdef HAS_SPOT_LIGHTS
  if (type == SPOT_LIGHT) {
    if (light.radius <= 0.0) {
      vec3 toPoint = light.position - r.o;
      float projection = dot(toPoint, r.d);
      vec3 perpendicular = toPoint - projection * r.d;
      if (projection <= EPS || dot(perpendicular, perpendicular) > 1e-8) return INF;
      d = projection;
      lightSample.direction = r.d;
      lightSample.normal = -r.d;
      lightSample.dist = d;
      lightSample.pdf = 1.0;
      lightSample.isDelta = true;
    } else {
      d = intersectSphere(light.radius, light.position, r);
      lightSample.isDelta = false;
    }
    if (d != INF) {
      vec3 hitPt = r.o + d * r.d;
      float multiplier = evaluateSpotEmissionMultiplier(light, normalize(r.o - hitPt));
      if (multiplier <= 0.0) return INF;
      if (light.radius > 0.0) {
        lightSample.pdf = sphereSolidAnglePdf(r.o, light.position, light.radius);
      }
      lightSample.emission = light.emission * multiplier * (light.radius <= 0.0
        ? 1.0 / max(d * d, 1e-8)
        : 1.0);
    }
  }
#endif

  return d;
}
#endif

int randomPickMaterial(ivec4 m0, ivec4 m1, ivec4 m2, vec3 bary) {
  vec2 m00 = unpackMaterialIndex(m0.x);
  vec2 m01 = unpackMaterialIndex(m0.y);
  vec2 m02 = unpackMaterialIndex(m0.z);
  vec2 m10 = unpackMaterialIndex(m1.x);
  vec2 m11 = unpackMaterialIndex(m1.y);
  vec2 m12 = unpackMaterialIndex(m1.z);
  vec2 m20 = unpackMaterialIndex(m2.x);
  vec2 m21 = unpackMaterialIndex(m2.y);
  vec2 m22 = unpackMaterialIndex(m2.z);
  float w00 = m00.y * bary.x;
  float w01 = m01.y * bary.x;
  float w02 = m02.y * bary.x;
  float w10 = m10.y * bary.y;
  float w11 = m11.y * bary.y;
  float w12 = m12.y * bary.y;
  float w20 = m20.y * bary.z;
  float w21 = m21.y * bary.z;
  float w22 = m22.y * bary.z;

  float wTotal = w00 + w01 + w02 + w10 + w11 + w12 + w20 + w21 + w22;
  // Accumulate weights
  w00 = w00 / wTotal;
  w01 = w01 / wTotal + w00;
  w02 = w02 / wTotal + w01;
  w10 = w10 / wTotal + w02;
  w11 = w11 / wTotal + w10;
  w12 = w12 / wTotal + w11;
  w20 = w20 / wTotal + w12;
  w21 = w21 / wTotal + w20;
  w22 = w22 / wTotal + w21;

  float rand = hashedSample(0u);
  float mIdx;
  if (rand < w00) {
    mIdx = m00.x;
  } else if (rand < w01) {
    mIdx = m01.x;
  } else if (rand < w02) {
    mIdx = m02.x;
  } else if (rand < w10) {
    mIdx = m10.x;
  } else if (rand < w11) {
    mIdx = m11.x;
  } else if (rand < w12) {
    mIdx = m12.x;
  } else if (rand < w20) {
    mIdx = m20.x;
  } else if (rand < w21) {
    mIdx = m21.x;
  } else {
    mIdx = m22.x;
  }
  return int(mIdx);
}


vec4 fetchIns(int i);


mat2x3 anisotropy_axes(vec3 normal, vec3 dp1, vec3 dp2, vec2 duv1, vec2 duv2, vec4 inputTangent) {
  float determinant = duv1.x * duv2.y - duv1.y * duv2.x;
  vec3 t = inputTangent.xyz;
  vec3 b = vec3(0.0);
  // Internal W=2 marks an authored XYZ tangent whose sign is derived from UVs.
  float handedness = abs(inputTangent.w) > 1.5 ? 0.0 : inputTangent.w;
  if (abs(determinant) > 1e-12) {
    vec3 dt = (dp1 * duv2.y - dp2 * duv1.y) / determinant;
    vec3 db = (dp2 * duv1.x - dp1 * duv2.x) / determinant;
    if (dot(t, t) < 1e-8) { t = dt; }
    if (handedness == 0.0) { handedness = (dot(cross(normal, dt), db) < 0.0 ? -1.0 : 1.0); }
  }
  t -= normal * dot(normal, t);
  if (dot(t, t) < 1e-8) {
    float signZ = (normal.z >= 0.0 ? 1.0 : -1.0);
    float factor = -1.0 / (signZ + normal.z);
    float xy = normal.x * normal.y * factor;
    t = vec3(1.0 + signZ * normal.x * normal.x * factor, signZ * xy, -signZ * normal.x);
    b = vec3(xy, signZ + normal.y * normal.y * factor, -normal.y);
  }
  else { t = normalize(t); b = normalize(cross(normal, t)); }
  return mat2x3(t, b * (handedness < 0.0 ? -1.0 : 1.0));
}

void fetchAttributes(inout SurfaceInteraction si, Triangle tri, vec3 barycentric, ivec3 index) {
  si.hit = true;
  si.position = barycentric.x * tri.p0 + barycentric.y * tri.p1 + barycentric.z * tri.p2;
  ivec2 i0 = unpackTexel(index.x, vertexColumns);
  ivec2 i1 = unpackTexel(index.y, vertexColumns);
  ivec2 i2 = unpackTexel(index.z, vertexColumns);
  si.vertexColor = vec3(1.0);
#ifdef USE_VERTEX_COLOR
  si.vertexColor = barycentric.x * texelFetch(colorBuffer, i0, 0).rgb
    + barycentric.y * texelFetch(colorBuffer, i1, 0).rgb
    + barycentric.z * texelFetch(colorBuffer, i2, 0).rgb;
#endif

  vec3 n0 = texelFetch(normalBuffer, i0, 0).xyz;
  vec3 n1 = texelFetch(normalBuffer, i1, 0).xyz;
  vec3 n2 = texelFetch(normalBuffer, i2, 0).xyz;
  vec3 normal = normalize(barycentric.x * n0 + barycentric.y * n1 + barycentric.z * n2);
  si.vertexNormal = normal;

  // Approximate the smooth limit surface at this triangle hit. Direct-light
  // rays use this geometric offset only near the shadow terminator, avoiding
  // false self-shadowing by adjacent facets without moving ordinary hits.
  // Architecture follows Cycles' shadow_ray_smooth_surface_offset.
  vec3 geometricNormal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
  vec3 smoothNormal = barycentric.x * n0 + barycentric.y * n1 + barycentric.z * n2;
  float a = dot(n2 - n0, tri.p0 - tri.p2);
  float b = dot(n2 - n1, tri.p1 - tri.p2);
  float c = dot(n1 - n0, tri.p1 - tri.p0);
  float h = a * barycentric.x * (barycentric.x - 1.0)
    + (a + b + c) * barycentric.x * barycentric.y
    + b * barycentric.y * (barycentric.y - 1.0);
  if (dot(smoothNormal, geometricNormal) > 0.0) {
    float h0 = max(max(dot(tri.p1 - tri.p0, n0), dot(tri.p2 - tri.p0, n0)), 0.0);
    float h1 = max(max(dot(tri.p0 - tri.p1, n1), dot(tri.p2 - tri.p1, n1)), 0.0);
    float h2 = max(max(dot(tri.p0 - tri.p2, n2), dot(tri.p1 - tri.p2, n2)), 0.0);
    h0 = max(dot(tri.p0 - si.position, n0) + h0, 0.0);
    h1 = max(dot(tri.p1 - si.position, n1) + h1, 0.0);
    h2 = max(dot(tri.p2 - si.position, n2) + h2, 0.0);
    h = max(min(min(h0, h1), h2), h * 0.5);
  }
  else {
    float h0 = max(max(dot(tri.p0 - tri.p1, n0), dot(tri.p0 - tri.p2, n0)), 0.0);
    float h1 = max(max(dot(tri.p1 - tri.p0, n1), dot(tri.p1 - tri.p2, n1)), 0.0);
    float h2 = max(max(dot(tri.p2 - tri.p0, n2), dot(tri.p2 - tri.p1, n2)), 0.0);
    h0 = max(dot(si.position - tri.p0, n0) + h0, 0.0);
    h1 = max(dot(si.position - tri.p1, n1) + h1, 0.0);
    h2 = max(dot(si.position - tri.p2, n2) + h2, 0.0);
    h = min(-min(min(h0, h1), h2), h * 0.5);
  }
  si.shadowOffset = smoothNormal * h;

  // TODO currently isampler doesn't work
  ivec4 m0 = ivec4(texelFetch(materialIndexBuffer, i0, 0));
  ivec4 m1 = ivec4(texelFetch(materialIndexBuffer, i1, 0));
  ivec4 m2 = ivec4(texelFetch(materialIndexBuffer, i2, 0));
  
  if (m0.x > 0 || m1.x > 0 || m2.x > 0) {
    si.materialIndex = randomPickMaterial(m0, m1, m2, barycentric);
  }
  
  vec2 uv0 = texelFetch(uvBuffer, i0, 0).xy;
  vec2 uv1 = texelFetch(uvBuffer, i1, 0).xy;
  vec2 uv2 = texelFetch(uvBuffer, i2, 0).xy;
  #if defined(NUM_DIFFUSE_MAPS) || defined(NUM_NORMAL_MAPS) || defined(NUM_METALLIC_ROUGHNESS_MAPS) || defined(NUM_ROUGHNESS_MAPS) || defined(NUM_METALNESS_MAPS) || defined(NUM_EMISSIVE_MAPS) || defined(NUM_THIN_FILM_MAPS) || defined(NUM_ANISOTROPY_MAPS) || defined(NUM_COAT_NORMAL_MAPS)
    vec2 uv = barycentric.x * uv0 + barycentric.y * uv1 + barycentric.z * uv2;
    vec2 secondaryUv0 = texelFetch(uv1Buffer, i0, 0).xy;
    vec2 secondaryUv1 = texelFetch(uv1Buffer, i1, 0).xy;
    vec2 secondaryUv2 = texelFetch(uv1Buffer, i2, 0).xy;
    vec2 secondaryUv = barycentric.x * secondaryUv0
      + barycentric.y * secondaryUv1
      + barycentric.z * secondaryUv2;

    vec4 uvInfo = fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_UV);
    int uvProjection = int(uvInfo.r);
    if (uvProjection > 0) {
      uv = projectUV(uvProjection, si.position, normal, uvInfo.zw);
      secondaryUv = uv;
    } else {
      uv *= uvInfo.zw;
      secondaryUv *= uvInfo.zw;
    }
  #else
    vec2 uv = vec2(0.0);
    vec2 secondaryUv = vec2(0.0);
  #endif

#ifdef USE_COAT_NORMAL_FRAMES
  si.coatNormal = normal;
#ifdef NUM_COAT_NORMAL_MAPS
  float coatNormalIndex = fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_LAYER_MAPS).z;
#endif
#endif
  vec4 directionMaterial = fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_DIRECTION_NORMAL);
  float coatRotation = fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_FILM_TEXTURE).x;
  if (directionMaterial.x >= 0.0 || directionMaterial.y != 0.0 || coatRotation != 0.0
#ifdef USE_COAT_NORMAL_FRAMES
    || fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_COAT).w > 0.0
#endif
  ) {
    vec3 dp1 = tri.p0 - tri.p2;
    vec3 dp2 = tri.p1 - tri.p2;
    vec4 inputTangent = vec4(0.0);
#ifdef USE_TANGENT
    inputTangent = barycentric.x * texelFetch(tangentBuffer, i0, 0)
      + barycentric.y * texelFetch(tangentBuffer, i1, 0)
      + barycentric.z * texelFetch(tangentBuffer, i2, 0);
#endif
    mat2x3 geometryAxes = anisotropy_axes(normal, dp1, dp2, uv0-uv2, uv1-uv2, inputTangent);
    si.geometryTangent = geometryAxes[0];
    si.geometryBitangent = geometryAxes[1];
    mat2x3 directionAxes = geometryAxes;
#ifdef NUM_ANISOTROPY_MAPS
    if (directionMaterial.x >= 0.0 && mapUvChannel[int(directionMaterial.x)] > 0.5) {
      vec2 a = texelFetch(uv1Buffer, i0, 0).xy;
      vec2 b = texelFetch(uv1Buffer, i1, 0).xy;
      vec2 c = texelFetch(uv1Buffer, i2, 0).xy;
      directionAxes = anisotropy_axes(normal, dp1, dp2, a-c, b-c, (inputTangent.w == 0.0 ? vec4(0.0) : inputTangent));
    }
#endif
    si.directionTangent = directionAxes[0];
    si.directionBitangent = directionAxes[1];
#if defined(USE_COAT_NORMAL_FRAMES) && defined(NUM_COAT_NORMAL_MAPS)
    if (coatNormalIndex >= 0.0) {
      int coatIndex = int(coatNormalIndex);
      mat2x3 coatAxes = geometryAxes;
      if (mapUvChannel[coatIndex] > 0.5) {
        vec2 a = texelFetch(uv1Buffer, i0, 0).xy;
        vec2 b = texelFetch(uv1Buffer, i1, 0).xy;
        vec2 c = texelFetch(uv1Buffer, i2, 0).xy;
        coatAxes = anisotropy_axes(normal, dp1, dp2, a-c, b-c,
          inputTangent.w == 0.0 ? vec4(0.0) : inputTangent);
      }
      vec3 decoded = sampleMap(coatIndex, getMapUvSet(coatIndex, uv, secondaryUv)).rgb * 2.0 - 1.0;
      vec3 mapped = coatAxes[0] * decoded.x * directionMaterial.z
        + coatAxes[1] * decoded.y * directionMaterial.w + normal * decoded.z;
      if (dot(mapped, mapped) > 1e-12) { si.coatNormal = normalize(mapped); }
    }
#endif
  }

  si.uv = uv;
  si.uv1 = secondaryUv;

  #ifdef USE_TANGENT
    vec3 t0 = texelFetch(tangentBuffer, i0, 0).xyz;
    vec3 t1 = texelFetch(tangentBuffer, i1, 0).xyz;
    vec3 t2 = texelFetch(tangentBuffer, i2, 0).xyz;
    si.tangent = normalize(barycentric.x * t0 + barycentric.y * t1 + barycentric.z * t2);
  #endif
  #if defined(NUM_NORMAL_MAPS)
    vec3 dp1 = tri.p0 - tri.p2;
    vec3 dp2 = tri.p1 - tri.p2;
    vec2 duv1 = uv0 - uv2;
    vec2 duv2 = uv1 - uv2;
    si.normal = getMatNormal(
      si.materialIndex, uv, normal, dp1, dp2, duv1, duv2
    );
  #else
    si.normal = normal;
  #endif
}

struct TriangleIntersect {
  float t;
  vec3 barycentric;
};

vec4 fetchBVH(int i) {
  return fetchData(bvhBuffer, i, bvhColumns);
}

vec4 fetchIns(int i) {
  return fetchData(instancesBuffer, i, instancesColumns);
}

// GLSL ES 3.00 has no bitCount intrinsic. Count the CWBVH mask bits using
// integer operations supported by WebGL 2.
uint countBvhBits(uint value) {
  value -= (value >> 1u) & 0x55555555u;
  value = (value & 0x33333333u) + ((value >> 2u) & 0x33333333u);
  value = (value + (value >> 4u)) & 0x0f0f0f0fu;
  return (value * 0x01010101u) >> 24u;
}

vec4 unpackBvh4Bounds(uint packedBounds) {
  return vec4(
    float(packedBounds & 0xffu),
    float((packedBounds >> 8u) & 0xffu),
    float((packedBounds >> 16u) & 0xffu),
    float(packedBounds >> 24u)
  ) / 255.0;
}

// Triangle-ray intersection
// Faster than the classic Möller–Trumbore intersection algorithm
// http://www.pbr-book.org/3ed-2018/Shapes/Triangle_Meshes.html#TriangleIntersection
TriangleIntersect intersectTriangle(vec3 o, vec3 d, Triangle tri, int maxDim, vec3 shear, float tMax) {
  TriangleIntersect ti;

  // translate vertices based on ray origin
  vec3 p0t = tri.p0 - o;
  vec3 p1t = tri.p1 - o;
  vec3 p2t = tri.p2 - o;

  // permute components of triangle vertices
  if (maxDim == 0) {
    p0t = p0t.yzx;
    p1t = p1t.yzx;
    p2t = p2t.yzx;
  } else if (maxDim == 1) {
    p0t = p0t.zxy;
    p1t = p1t.zxy;
    p2t = p2t.zxy;
  }

  // apply shear transformation to translated vertex positions
  p0t.xy += shear.xy * p0t.z;
  p1t.xy += shear.xy * p1t.z;
  p2t.xy += shear.xy * p2t.z;

  // compute edge function coefficients
  vec3 e = vec3(
    p1t.x * p2t.y - p1t.y * p2t.x,
    p2t.x * p0t.y - p2t.y * p0t.x,
    p0t.x * p1t.y - p0t.y * p1t.x
  );

#ifdef DEPTH_QUERY_MODE
  vec3 edgeScale = abs(vec3(p1t.x * p2t.y, p2t.x * p0t.y, p0t.x * p1t.y))
    + abs(vec3(p1t.y * p2t.x, p2t.y * p0t.x, p0t.y * p1t.x));
  e = mix(e, vec3(0.0), lessThanEqual(abs(e), edgeScale * 1e-6));
#endif

  // check if intersection is inside triangle
  if (any(lessThan(e, vec3(0))) && any(greaterThan(e, vec3(0)))) {
    return ti;
  }

  float det = e.x + e.y + e.z;
#ifdef DEPTH_QUERY_MODE
  if (det == 0.0) return ti;
#endif

  p0t.z *= shear.z;
  p1t.z *= shear.z;
  p2t.z *= shear.z;
  float tScaled = (e.x * p0t.z + e.y * p1t.z + e.z * p2t.z);

  // check if closer intersection already exists
  if (abs(tScaled) > abs(tMax * det)) {
    return ti;
  }

  float invDet = 1. / det;
  ti.t = tScaled * invDet;
  ti.barycentric = e * invDet;

  return ti;
}

struct Box {
  vec3 min;
  vec3 max;
};

// Conservative slabs only for the unjittered depth query shader.
vec3 traversalInverse(vec3 d) {
#ifdef DEPTH_QUERY_MODE
  vec3 denominator = mix(d, mix(vec3(1e-20), vec3(-1e-20), lessThan(d, vec3(0.0))), lessThan(abs(d), vec3(1e-20)));
  return 1.0 / denominator;
#else
  return 1.0 / d;
#endif
}

vec3 depthSlabPadding(vec3 invD, vec3 o) {
#ifdef DEPTH_QUERY_MODE
  return abs(invD) * max(vec3(1.0), abs(o)) * 1e-6;
#else
  return vec3(0.0);
#endif
}

// Branchless ray/box intersection
// https://tavianator.com/fast-branchless-raybounding-box-intersections/
float intersectBox(vec3 o, vec3 d, vec3 bmin, vec3 bmax, float tMax) {
#ifdef DEPTH_QUERY_MODE
  vec3 invD = traversalInverse(d);
  vec3 tBot = (bmin - o) * invD;
  vec3 tTop = (bmax - o) * invD;
  vec3 padding = depthSlabPadding(invD, o);
#else
  vec3 tBot = (bmin - o) / d;
  vec3 tTop = (bmax - o) / d;
  vec3 padding = vec3(0.0);
#endif
  vec3 tNear = min(tBot, tTop) - padding;
  vec3 tFar = max(tBot, tTop) + padding;
  float t0 = max(tNear.x, max(tNear.y, tNear.z));
  float t1 = min(tFar.x, min(tFar.y, tFar.z));

  return (t0 > t1 || t0 > tMax) ? -1.0 : (t0 > 0.0 ? t0 : t1);
}

int maxDimension(vec3 v) {
  return v.x > v.y ? (v.x > v.z ? 0 : 2) : (v.y > v.z ? 1 : 2);
}

vec3 getShear(vec3 d, int maxDim) {
  // Permute space so that the z dimension is the one where the absolute value of the ray's direction is largest.
  // Then create a shear transformation that aligns ray direction with the +z axis
  if (maxDim == 0) {
    return vec3(-d.y, -d.z, 1.0) / d.x;
  } else if (maxDim == 1) {
    return vec3(-d.z, -d.x, 1.0) / d.y;
  } else {
    return vec3(-d.x, -d.y, 1.0) / d.z;
  }
}

// Traverse BVH, find closest triangle intersection, and return surface information
void intersectScene(in Ray ray, inout SurfaceInteraction si, bool doubleSided) {
  si.hit = false;

  if (isEmptyScene) {
    return;
  }

  int maxDim = maxDimension(abs(ray.d));
  vec3 shear = getShear(ray.d, maxDim);
  int hitInsIdx;

${getBVHTraverseCode(glsl`
  si.triangleIndex = triangleIndex;
  hitTri = tri;
  hitFaceNormal = faceNormal;
  hitBarycentric = hit.barycentric;
  hitIndex = index;
  isHit = true;
  hitInsIdx = insIdx;
`)}

  if (isHit) {
    si.instanceIndex = hitInsIdx;
    si.materialIndex = int(unpackMaterialIndex(floatBitsToInt(fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE}).z)).x);
    // fetchAttributes before transform to world space.
    fetchAttributes(si, hitTri, hitBarycentric, hitIndex);
    mat4 l2w = mat4(
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 5),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 6),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 7),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 8)
    );
    mat4 w2l = mat4(
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 1),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 2),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 3),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 4)
    );
    mat3 normalTransform = transpose(mat3(w2l));
    si.faceNormal = normalize(normalTransform * hitFaceNormal);
    si.vertexNormal = normalize(normalTransform * si.vertexNormal);
    si.normal = normalize(normalTransform * si.normal);
#ifdef USE_COAT_NORMAL_FRAMES
    si.coatNormal = normalize(normalTransform * si.coatNormal);
#endif
#ifdef USE_TANGENT
    if (dot(si.tangent, si.tangent) > 0.0) {
      si.tangent = normalize(mat3(l2w) * si.tangent);
    }
#endif
    si.shadowOffset = (l2w * vec4(si.shadowOffset, 0.0)).xyz;
    si.directionTangent = mat3(l2w) * si.directionTangent;
    si.directionBitangent = mat3(l2w) * si.directionBitangent;
    si.geometryTangent = mat3(l2w) * si.geometryTangent;
    si.geometryBitangent = mat3(l2w) * si.geometryBitangent;
    si.position = (l2w * vec4(si.position, 1.0)).xyz;
  }
}

// Local intersection helper for shader bevel.
void intersectSceneBevel(in Ray ray, inout SurfaceInteraction si, int instanceIndex, float maxDistance) {
  si.hit = false;

  if (isEmptyScene) {
    return;
  }

  bool doubleSided = true;
  int maxDim = maxDimension(abs(ray.d));
  vec3 shear = getShear(ray.d, maxDim);
  int hitInsIdx;

${getBVHTraverseCode(
  glsl`
  si.triangleIndex = triangleIndex;
  hitTri = tri;
  hitFaceNormal = faceNormal;
  hitBarycentric = hit.barycentric;
  hitIndex = index;
  isHit = true;
  hitInsIdx = insIdx;
`,
  glsl`
          if (insIdx != instanceIndex) {
            continue;
          }
`,
  'maxDistance'
)}

  if (isHit) {
    si.instanceIndex = hitInsIdx;
    si.materialIndex = int(unpackMaterialIndex(floatBitsToInt(fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE}).z)).x);
    fetchAttributes(si, hitTri, hitBarycentric, hitIndex);
    mat4 l2w = mat4(
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 5),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 6),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 7),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 8)
    );
    mat4 w2l = mat4(
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 1),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 2),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 3),
      fetchIns(hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 4)
    );
    mat3 normalTransform = transpose(mat3(w2l));
    si.faceNormal = normalize(normalTransform * hitFaceNormal);
    si.vertexNormal = normalize(normalTransform * si.vertexNormal);
    si.normal = normalize(normalTransform * si.normal);
#ifdef USE_COAT_NORMAL_FRAMES
    si.coatNormal = normalize(normalTransform * si.coatNormal);
#endif
#ifdef USE_TANGENT
    if (dot(si.tangent, si.tangent) > 0.0) {
      si.tangent = normalize(mat3(l2w) * si.tangent);
    }
#endif
    si.shadowOffset = (l2w * vec4(si.shadowOffset, 0.0)).xyz;
    si.directionTangent = mat3(l2w) * si.directionTangent;
    si.directionBitangent = mat3(l2w) * si.directionBitangent;
    si.geometryTangent = mat3(l2w) * si.geometryTangent;
    si.geometryBitangent = mat3(l2w) * si.geometryBitangent;
    si.position = (l2w * vec4(si.position, 1.0)).xyz;
  }
}

bool intersectSceneShadow(in Ray ray, float lightDistance, int currTriangleIndex) {

  if (isEmptyScene) {
    return false;
  }

  bool doubleSided = true;
  int maxDim = maxDimension(abs(ray.d));
  vec3 shear = getShear(ray.d, maxDim);

${getBVHTraverseCode(
  glsl`
  // Traversal is clipped to lightDistance. Affine instance transforms keep
  // the ray parameter unchanged because local directions are not normalized.
  bool isOccluded = true;
  vec3 barycentric = hit.barycentric;
  vec3 position = barycentric.x * tri.p0 + barycentric.y * tri.p1 + barycentric.z * tri.p2;

  if (isOccluded) {
#ifdef HAS_ALPHA
    int materialIndex = int(unpackMaterialIndex(floatBitsToInt(fetchIns(insIdx * ${INSTANCE_VEC4_STRIDE}).z)).x);
    ivec2 i0 = unpackTexel(index.x, vertexColumns);
    ivec2 i1 = unpackTexel(index.y, vertexColumns);
    ivec2 i2 = unpackTexel(index.z, vertexColumns);
    ivec4 m0 = ivec4(texelFetch(materialIndexBuffer, i0, 0));
    ivec4 m1 = ivec4(texelFetch(materialIndexBuffer, i1, 0));
    ivec4 m2 = ivec4(texelFetch(materialIndexBuffer, i2, 0));
      
    if (m0.x > 0 || m1.x > 0 || m2.x > 0) {
      materialIndex = randomPickMaterial(m0, m1, m2, barycentric);
    }
  
    int ii = materialIndex * MAT_DATA_SIZE;
    int mapAlphaUsage = int(fetchMatData(ii + MAT_ROW_MISC).a);
    float alpha = fetchMatData(ii + MAT_ROW_ALPHA_FILM).r;
  #ifdef NUM_DIFFUSE_MAPS
    if (mapAlphaUsage == ${mapAlphaUsageConstants.alpha + ''}) {
      int diffuseMapIndex = int(fetchMatData(ii + MAT_ROW_METALLIC_MAPS).z);
      if (diffuseMapIndex >= 0) {
        vec2 uv0 = texelFetch(uvBuffer, i0, 0).xy;
        vec2 uv1 = texelFetch(uvBuffer, i1, 0).xy;
        vec2 uv2 = texelFetch(uvBuffer, i2, 0).xy;
        vec2 uv = barycentric.x * uv0 + barycentric.y * uv1 + barycentric.z * uv2;
        vec4 uvInfo = fetchMatData(ii + MAT_ROW_UV);
        int uvProjection = int(uvInfo.r);
        if (uvProjection > 0) {
          uv = projectUV(uvProjection, position, hitFaceNormal, uvInfo.zw);
        } else {
          uv *= uvInfo.zw;
        }
        
        alpha *= sampleMap(diffuseMapIndex, uv).a;
      }
    }
  #endif
  #ifdef NUM_ALPHA_MAPS
    int alphaMapIndex = int(fetchMatData(ii + MAT_ROW_STANDALONE_MAPS).z);
    if (alphaMapIndex >= 0) {
      vec2 uv0 = texelFetch(uvBuffer, i0, 0).xy;
      vec2 uv1 = texelFetch(uvBuffer, i1, 0).xy;
      vec2 uv2 = texelFetch(uvBuffer, i2, 0).xy;
      vec2 uv = barycentric.x * uv0 + barycentric.y * uv1 + barycentric.z * uv2;
      vec4 uvInfo = fetchMatData(ii + MAT_ROW_UV);
      int uvProjection = int(uvInfo.r);
      if (uvProjection > 0) {
        uv = projectUV(uvProjection, position, hitFaceNormal, uvInfo.zw);
      } else {
        uv *= uvInfo.zw;
      }
      alpha *= sampleMap(alphaMapIndex, uv).g;
    }
  #endif
    float alphaCutoff = fetchMatData(ii + MAT_ROW_STANDALONE_MAPS).a;
    alpha = resolveMaterialAlpha(
      alpha, int(fetchMatData(ii + MAT_ROW_ALPHA).w), alphaCutoff
    );
    if (hashedSample(0u) > alpha) {
      // Continue after a transparent hit without traversing beyond the light.
      tMax = min(max(lightDistance, 0.0), RAY_MAX_DISTANCE);
      isOccluded = false;
    }
#endif
  }
  if (isOccluded) {
    return true;
  }
`,
  glsl`
  if (triangleIndex == currTriangleIndex) {
    continue;
  }
`,
  'min(max(lightDistance, 0.0), RAY_MAX_DISTANCE)'
)}
  return false;
}
`
});
