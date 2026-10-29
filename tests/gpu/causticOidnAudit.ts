import type Engine from '../../src/Engine.js';
import type Render from '../../src/Render.js';

/** Snapshot the actual built-in network inputs without changing its execution. */
export function auditOidn(engine: Engine, render: Render, name: string, samples: number) {
  const pending: Promise<void>[] = [];
  const network = (render as any)._filter.denoiser;
  const original = network.tileExecute.bind(network);
  function capture(data: GPUBuffer, label: string, width: number, height: number) {
    const device = engine.device!;
    const staging = device.createBuffer({size: width * height * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(data, 0, staging, 0, staging.size);
    device.queue.submit([encoder.finish()]);
    pending.push((async () => {
      await staging.mapAsync(GPUMapMode.READ);
      const body = staging.getMappedRange().slice(0);
      staging.unmap(); staging.destroy();
      const response = await fetch('/__evidence/' + name + '-' + label + '.f32', {method: 'POST', body});
      if (!response.ok) throw Error('OIDN audit write failed');
    })());
  }
  network.tileExecute = (options: any) => {
    if (render.samples !== samples) return original(options);
    for (const key of ['color', 'albedo', 'normal']) {
      const plane = options[key];
      if (plane) capture(plane.data, key, plane.width, plane.height);
    }
    return original({...options, done(output: any) {
      capture(output.data, 'output', output.width, output.height);
      options.done(output);
    }});
  };
  return async () => {network.tileExecute = original; await Promise.all(pending);};
}
