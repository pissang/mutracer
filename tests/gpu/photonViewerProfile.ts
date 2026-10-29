/** Opt-in, test-only per-command GPU timestamps; production scheduling stays active. */
export function profileViewer(viewer: any) {
  const device: GPUDevice = viewer.engine.device;
  if (!device.features.has('timestamp-query')) throw Error('Real GPU timestamps required');
  const rows: any[] = [], tasks: Promise<void>[] = [], calls: any[] = [];
  const commands = new WeakMap<GPUCommandBuffer, () => void>();
  let frame = 0, enabled = false, started = 0;
  const create = device.createCommandEncoder.bind(device), submit = device.queue.submit.bind(device.queue);
  device.createCommandEncoder = descriptor => {
    const encoder = create(descriptor);
    if (!enabled) return encoder;
    const pairs: any[] = [];
    const query = device.createQuerySet({type: 'timestamp', count: 256});
    for (const method of ['beginComputePass', 'beginRenderPass'] as const) {
      const begin = encoder[method].bind(encoder) as any;
      (encoder as any)[method] = (desc: any = {}) => {
        const index = pairs.length * 2;
        const writes = desc.timestampWrites ?? {querySet: query, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1};
        const pair: any = {label: desc.label ?? descriptor?.label ?? method, writes, pipelines: []};
        pairs.push(pair);
        const pass = begin({...desc, timestampWrites: writes});
        const set = pass.setPipeline.bind(pass);
        pass.setPipeline = (pipeline: GPUComputePipeline) => {pair.pipelines.push(pipeline.label); set(pipeline);};
        return pass;
      };
    }
    const finish = encoder.finish.bind(encoder);
    encoder.finish = desc => {
      if (!pairs.length) {query.destroy(); return finish(desc);}
      const size = pairs.length * 256;
      const resolve = device.createBuffer({size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      const read = device.createBuffer({size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      pairs.forEach((p, i) => encoder.resolveQuerySet(p.writes.querySet, p.writes.beginningOfPassWriteIndex, 2, resolve, i * 256));
      encoder.copyBufferToBuffer(resolve, 0, read, 0, size);
      const command = finish(desc), currentFrame = frame;
      commands.set(command, () => {
        const at = performance.now();
        tasks.push(read.mapAsync(GPUMapMode.READ).then(() => {
          const values = new BigUint64Array(read.getMappedRange());
          pairs.forEach((p, i) => rows.push({frame: currentFrame, submitted: at, ready: performance.now(), label: p.label, pipelines: p.pipelines, ms: Number(values[i*32+1] - values[i*32]) / 1e6}));
          read.unmap();read.destroy();resolve.destroy();query.destroy();
        }));
      });
      return command;
    };
    return encoder;
  };
  device.queue.submit = buffers => {const list = Array.from(buffers); submit(list); for (const b of list) commands.get(b)?.();};
  const wrap = (owner: any, name: string, category: string) => {
    const original = owner[name].bind(owner);
    owner[name] = (...args: any[]) => {
      const start = performance.now(), before = viewer.final.samples;
      if (category === 'tick') frame++;
      const result = original(...args);
      if (enabled) calls.push({category, frame, start, end: performance.now(), before, after: viewer.final.samples, denoising: viewer.final.denoising, tiles: viewer.final._output?.getDiagnostics?.()?.gpuTraceTiming});
      return result;
    };
  };
  wrap(viewer.final, 'refine', 'refine'); wrap(viewer.loop, 'tick', 'tick'); wrap(viewer.engine.display, 'present', 'present');
  const wait = viewer.final.whenReadyToRefine.bind(viewer.final);
  viewer.final.whenReadyToRefine = () => {
    const start = performance.now(), currentFrame = frame;
    return wait().then(() => {
      if (enabled) calls.push({category:'queue-wait', frame:currentFrame, start, end:performance.now()});
    });
  };
  const output = viewer.final._output;
  if (output) {
    const original = output.performDenoise.bind(output);
    output.performDenoise = async (...args: any[]) => {
      const start = performance.now(), samples = viewer.final.samples;
      const result = await original(...args);
      if (enabled) calls.push({category: 'oidn', start, end: performance.now(), samples});
      return result;
    };
  }
  return {
    start() {rows.length = calls.length = tasks.length = 0;frame = 0;started = performance.now();enabled = true;},
    async stop() {enabled = false;await device.queue.onSubmittedWorkDone();await Promise.all(tasks);return {started,ended:performance.now(),rows,calls,adapter:viewer.engine.getDiagnostics()?.adapterName};}
  };
}
