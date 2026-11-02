// Float32 addition implemented with u32 compare/exchange works on baseline
// WebGPU, without a fixed radiance quantum or the Q16.16 saturation ceiling.
export default /* wgsl */ `
fn causticAtomicAdd(index:u32,value:f32) {
  if(!(value>0.0)||!(value<3.402823e38)){return;}
  var previous=atomicLoad(&splats[index]);
  loop {
    let sum=bitcast<f32>(previous)+value;
    let replacement=bitcast<u32>(sum);
    let result=atomicCompareExchangeWeak(&splats[index],previous,replacement);
    if(result.exchanged){break;}
    previous=result.old_value;
  }
}
`;
