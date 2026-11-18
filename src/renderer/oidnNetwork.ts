/// <reference types="@webgpu/types" preserve="true" />
import { initUNetFromBuffer, type UNet } from 'oidn-webgpu';
import type Engine from '../Engine.js';
import type { OIDNFilterOptions } from '../oidnOptions.js';
import type { DenoiseSchedule } from '../Render.js';
import {
  resolveOIDNModelUrl, resolveOIDNAuxiliaryModelUrls, DEFAULT_OIDN_WEIGHTS_BASE_URL,
  OIDN_WEIGHTS_PACKAGE
} from '../oidn.js';
import type {
  OIDNModel, OIDNEngine, OIDNPrecision, OIDNHDRTransfer,
  OIDNDynamicTileSetting, OIDNAuxiliaryModelUrls
} from '../oidn.js';

export interface OIDNAuxiliaryDenoisers {
  /** Loaded albedo prefilter; supplied by the clean-aux loader. */
  albedo: OIDNDenoiser;
  /** Loaded normal prefilter; supplied by the clean-aux loader. */
  normal: OIDNDenoiser;
}
export type OIDNDenoiser = UNet & {
  /** Optional RT auxiliary filters used before a clean-aux beauty model. */
  auxiliaryDenoisers?: OIDNAuxiliaryDenoisers;
  /** Optional shape preparation supported by newer oidn-webgpu runtimes. */
  prepareForImage?: (
    width: number,
    height: number,
    options?: { tileOverlap?: number }
  ) => Promise<void>;
};

interface OIDNLoadOptions {
  /** Maximum OIDN tile size. By default oidn-webgpu chooses the tile size. */
  maxTileSize?: number;
  /** Optional signal used while downloading the weights. */
  signal?: AbortSignal;
  /** OIDN execution engine. `webnn` enables the experimental WebNN FP16 path. */
  engine?: OIDNEngine;
  /** Native WGSL precision. `auto` uses FP16 when shader-f16 is available. */
  precision?: OIDNPrecision;
  /** Adaptive tile controller settings, or false for fixed tiles. */
  dynamicTile?: OIDNDynamicTileSetting;
}

interface InitializeOIDNOptions extends OIDNLoadOptions {
  /** Packaged model to load. Defaults to the standard model. */
  model?: OIDNModel;
  /** Override directory for all weights. Defaults to bundled standard/small assets and the oidn-weights CDN for large networks. */
  weightsBaseUrl?: string | URL;
  /** Override the packaged albedo/normal prefilter weights for a clean-aux model. */
  auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
}

interface CustomOIDNModelOptions extends OIDNLoadOptions {
  /** Whether the custom model consumes albedo and normal guides. Defaults to true. */
  aux?: boolean;
  /** Whether the custom model consumes HDR color. Defaults to true. */
  hdr?: boolean;
  /** HDR encoding expected by the weights. OIDN's RT models use PU. */
  hdrTransfer?: OIDNHDRTransfer;
  /** Optional albedo/normal filters to run before the custom clean-aux model. */
  auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
}

async function fetchOIDNWeights(url: string | URL, signal?: AbortSignal) {
  const response = await fetch(String(url), { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to load OIDN weights from ${url}: ${response.status} ${response.statusText}`
    );
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0xD7 || bytes[1] !== 0x41) {
    throw new Error(`Invalid OIDN TZA weights from ${url}: expected magic D7 41 (received non-TZA content).`);
  }
  return buffer;
}

/**
 * Loads an HDR OIDN model with albedo/normal guides on the engine's WebGPU
 * device and returns it without attaching it to a render.
 */
async function loadOIDN(
  engine: Engine,
  weightsUrl: string | URL,
  options: CustomOIDNModelOptions = {},
  fetchWeights = fetchOIDNWeights
): Promise<OIDNDenoiser> {
  await engine.init();
  const device = engine.device;
  if (engine.backend !== 'webgpu' || !device) {
    throw new Error('OIDN requires a WebGPU engine.');
  }

  const auxiliaryUrls = options.auxiliaryModelUrls;
  const weightBuffers = await Promise.all([
    engine._getWeights(String(weightsUrl), () => fetchWeights(weightsUrl, options.signal)),
    ...(auxiliaryUrls
      ? [
          engine._getWeights(String(auxiliaryUrls.albedo), () => fetchWeights(auxiliaryUrls.albedo, options.signal)),
          engine._getWeights(String(auxiliaryUrls.normal), () => fetchWeights(auxiliaryUrls.normal, options.signal))
        ]
      : [])
  ]);
  const backend = { device };
  const runtimeOptions = {
    hdrTransfer: options.hdrTransfer ?? 'pu',
    maxTileSize: options.maxTileSize,
    engine: options.engine,
    precision: options.precision,
    dynamicTile: options.dynamicTile
  };
  let denoiser: OIDNDenoiser | undefined;
  let albedoDenoiser: OIDNDenoiser | undefined;
  try {
    denoiser = await initUNetFromBuffer(weightBuffers[0], backend, {
      aux: options.aux ?? true,
      hdr: options.hdr ?? true,
      ...runtimeOptions
    });
    if (auxiliaryUrls) {
      // Auxiliary RT networks are color-only three-channel UNets. The render
      // pipeline supplies their feature-specific transfer functions.
      albedoDenoiser = await initUNetFromBuffer(weightBuffers[1], backend, {
        aux: false,
        hdr: false,
        ...runtimeOptions
      });
      const normalDenoiser = await initUNetFromBuffer(
        weightBuffers[2],
        backend,
        {
          aux: false,
          hdr: false,
          ...runtimeOptions
        }
      );
      denoiser.auxiliaryDenoisers = {
        albedo: albedoDenoiser,
        normal: normalDenoiser
      };
    }
  } catch (error) {
    albedoDenoiser?.dispose();
    denoiser?.dispose();
    throw error;
  }
  return denoiser;
}

/** Loads an explicit HDR network URL; download failures never fall back to a CDN. */
function initializeOIDNFromURL(
  engine: Engine,
  weightsUrl: string | URL,
  options: CustomOIDNModelOptions = {}
): Promise<OIDNDenoiser> {
  return loadOIDN(engine, weightsUrl, options);
}

let warnedBundledWeights = false;

/** Loads one of the packaged OIDN models. */
function initializeOIDN(
  engine: Engine,
  options: InitializeOIDNOptions = {}
) {
  const {
    model = 'standard',
    weightsBaseUrl,
    auxiliaryModelUrls,
    ...loadOptions
  } = options;
  const mainUrl = resolveOIDNModelUrl(model, weightsBaseUrl);
  const defaultBundled = weightsBaseUrl === undefined && model !== 'cleanAuxLarge';
  const defaultLarge = new Set<string>(weightsBaseUrl === undefined && model === 'cleanAuxLarge'
    ? [mainUrl, ...(!auxiliaryModelUrls ? Object.values(resolveOIDNAuxiliaryModelUrls()).map(String) : [])]
    : []);
  const fetchWeights = async (url: string | URL, signal?: AbortSignal) => {
    try {
      return await fetchOIDNWeights(url, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (defaultBundled && String(url) === mainUrl) {
        if (!warnedBundledWeights) {
          warnedBundledWeights = true;
          console.warn('Bundled OIDN weights failed to load; falling back to jsDelivr. In Vite development add optimizeDeps: { exclude: ["@meimu/mutracer"] }, or pass weightsBaseUrl to self-host the weights.', error);
        }
        return fetchOIDNWeights(resolveOIDNModelUrl(model, DEFAULT_OIDN_WEIGHTS_BASE_URL), signal);
      }
      if (defaultLarge.has(String(url))) {
        throw new Error(`Failed to load ${OIDN_WEIGHTS_PACKAGE} network from ${url}. Self-host node_modules/oidn-weights/*.tza and pass weightsBaseUrl. ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  };
  return loadOIDN(
    engine,
    mainUrl,
    {
      ...loadOptions,
      auxiliaryModelUrls:
        auxiliaryModelUrls ?? (model === 'cleanAuxLarge'
          ? resolveOIDNAuxiliaryModelUrls(weightsBaseUrl) : undefined)
    },
    fetchWeights
  );
}

/** Internal lazy loader; both public OIDN option branches use this path. */
export function loadOIDNNetwork(engine: Engine, options: Readonly<OIDNFilterOptions & {type?: 'oidn'; schedule?: DenoiseSchedule}>): Promise<OIDNDenoiser> {
  if (options.weightsUrl !== undefined) return initializeOIDNFromURL(engine, options.weightsUrl, options);
  return initializeOIDN(engine, options);
}
