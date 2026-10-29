// Veach's adjoint shading-normal ratio. Directions point away from the vertex;
// view is toward the preceding light vertex, outgoing toward the camera.
// Reference: Veach 1997, thesis section 5.3 (mathematical formula, no copied code).
export default /* wgsl */ `
fn causticAdjoint(view:vec3f,outgoing:vec3f,shading:vec3f,geometric:vec3f)->f32 {
  let numerator=abs(dot(view,shading)*dot(outgoing,geometric));
  let denominator=abs(dot(view,geometric)*dot(outgoing,shading));
  if(denominator==0.0){return 0.0;}
  return numerator/denominator;
}
`;
