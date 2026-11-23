// Internal fixture input: additive accumulation in bottom-row-first order.
// Not part of src/main.ts or the supported rendering diagnostics contract.
export interface DisplayParityAccumulation {
  width: number; height: number; samples: number; catcher: boolean;
  color: Float32Array; albedo: Float32Array; normal: Float32Array;
  shadow: Float32Array; moments: Float32Array;
}

export interface DisplayParityGPUAccumulation {
  width: number; height: number; samples: number;
  color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer;
}

/** @internal Test-only access on concrete backend targets, never public diagnostics. */
export interface DisplayParityTarget {
  /** @internal */
  _displayParity(): {
    record(trace?: string[]): void;
    load(input: DisplayParityAccumulation): void;
    loadGPU?(input: DisplayParityGPUAccumulation): void;
    oidnInputs?(): {color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer};
  };
}
