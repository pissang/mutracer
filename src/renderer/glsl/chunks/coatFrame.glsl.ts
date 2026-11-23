export default /* glsl */ `#ifdef USE_COAT_NORMAL_FRAMES
vec3 coat_frame_normal(vec3 inputNormal, vec3 face, vec3 view) {
  bool front = dot(face, view) >= 0.0;
  vec3 ffFace = front ? face : -face;
  vec3 ffInput = front ? inputNormal : -inputNormal;
  if (dot(inputNormal, face) <= 0.0 || dot(ffInput, view) <= 1e-6) { return ffFace; }
  return ffInput;
}
#endif
`;
