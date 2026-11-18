import type {OIDNModel, OIDNEngine, OIDNPrecision, OIDNHDRTransfer, OIDNDynamicTileSetting, OIDNAuxiliaryModelUrls} from './oidn.js';

/** Loading and execution options shared by both OIDN network sources. */
interface OIDNSettings {
  /** Override albedo and normal prefilter networks. Default packaged filters for cleanAuxLarge, otherwise undefined. */ auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
  /** Execution backend. Default auto (native WGSL unless WebNN is selected). */ engine?: OIDNEngine;
  /** WGSL precision. Default auto (fp16 when shader-f16 is available). */ precision?: OIDNPrecision;
  /** Adaptive tile controller. Default enabled with minTileSize 256, initialTileSize 432, targetTileTimeMs 16, adjustmentStep 16. */ dynamicTile?: OIDNDynamicTileSetting;
  /** Maximum OIDN output tile edge in pixels. Default `512`. */ maxTileSize?: number;
  /** Abort weight downloads. Default undefined; does not distinguish cached networks. */ signal?: AbortSignal;
}
/** OIDN options for caller-owned GPU buffers. Choose a packaged model or an explicit network URL. */
export type OIDNFilterOptions = OIDNSettings & (
  | {
    /** Packaged network. Default standard. */ model?: OIDNModel;
    /** Weight directory override. Default bundled standard/small assets and CDN large weights. */ weightsBaseUrl?: string | URL;
    weightsUrl?: never; aux?: never; hdr?: never; hdrTransfer?: never;
  }
  | {
    /** Custom network file. Required in this branch; failures never fall back to CDN. */ weightsUrl: string | URL;
    /** Custom model consumes albedo and normal. Default true. */ aux?: boolean;
    /** Custom model consumes HDR color. Default true. */ hdr?: boolean;
    /** Custom model HDR encoding. Default pu. */ hdrTransfer?: OIDNHDRTransfer;
    model?: never; weightsBaseUrl?: never;
  }
);
export const OIDN_OPTION_KEYS = ['model', 'weightsBaseUrl', 'weightsUrl', 'aux', 'hdr', 'hdrTransfer', 'auxiliaryModelUrls', 'engine', 'precision', 'dynamicTile', 'maxTileSize', 'signal'];

function isURL(value: unknown): value is string | URL {
  return (typeof value === 'string' && value.length > 0) || value instanceof URL;
}

export function validateOIDNOptions(options: OIDNFilterOptions) {
  if (options.weightsUrl !== undefined) {
    if (options.model !== undefined || options.weightsBaseUrl !== undefined) throw new Error('weightsUrl is mutually exclusive with model and weightsBaseUrl.');
  } else if (options.aux !== undefined || options.hdr !== undefined || options.hdrTransfer !== undefined) throw new Error('aux, hdr and hdrTransfer require weightsUrl.');
  for (const key of ['weightsUrl', 'weightsBaseUrl'] as const) if (options[key] !== undefined && !isURL(options[key])) throw new Error(`${key} must be a nonempty string or URL.`);
  if (options.auxiliaryModelUrls !== undefined) {
    const urls = options.auxiliaryModelUrls;
    if (!urls || !isURL(urls.albedo) || !isURL(urls.normal) || Object.keys(urls).some(key => !['albedo', 'normal'].includes(key))) throw new Error('auxiliaryModelUrls requires only albedo and normal URLs.');
  }
  for (const [key, values] of [['engine', ['auto', 'wgsl', 'webnn']], ['precision', ['auto', 'fp32', 'fp16']], ['hdrTransfer', ['pu', 'log']]] as const) {
    if (options[key] !== undefined && !(values as readonly string[]).includes(options[key]!)) throw new Error(`Unknown OIDN ${key}.`);
  }
  for (const key of ['aux', 'hdr'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  if (options.dynamicTile !== undefined && typeof options.dynamicTile !== 'boolean') {
    if (!options.dynamicTile || typeof options.dynamicTile !== 'object') throw new Error('dynamicTile must be boolean or tile settings.');
    for (const [key, value] of Object.entries(options.dynamicTile)) {
      if (!['minTileSize', 'initialTileSize', 'targetTileTimeMs', 'adjustmentStep'].includes(key) || (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))) throw new Error(`Invalid dynamicTile ${key}.`);
    }
  }
  if (options.model !== undefined && !['standard', 'small', 'cleanAuxLarge'].includes(options.model)) throw new Error('Unknown OIDN model.');
  if (options.maxTileSize !== undefined && (!Number.isInteger(options.maxTileSize) || options.maxTileSize < 1)) throw new Error('maxTileSize must be a positive integer.');
}

export function snapshotOIDNOptions<T extends OIDNFilterOptions>(options: T): Readonly<T> {
  const next = {...options};
  if (options.weightsBaseUrl !== undefined) next.weightsBaseUrl = String(options.weightsBaseUrl);
  if (options.weightsUrl !== undefined) next.weightsUrl = String(options.weightsUrl);
  if (options.auxiliaryModelUrls !== undefined) next.auxiliaryModelUrls = Object.freeze({albedo: String(options.auxiliaryModelUrls.albedo), normal: String(options.auxiliaryModelUrls.normal)});
  if (typeof options.dynamicTile === 'object') next.dynamicTile = Object.freeze({...options.dynamicTile});
  return Object.freeze(next);
}

export function oidnDenoiserKey(options: Readonly<OIDNFilterOptions>) {
  const tile = options.dynamicTile;
  return JSON.stringify({type: 'oidn',
    ...(options.weightsUrl === undefined ? {model: options.model ?? 'standard', weightsBaseUrl: options.weightsBaseUrl?.toString()} : {weightsUrl: String(options.weightsUrl), aux: options.aux ?? true, hdr: options.hdr ?? true, hdrTransfer: options.hdrTransfer ?? 'pu'}),
    auxiliaryModelUrls: options.auxiliaryModelUrls && {albedo: String(options.auxiliaryModelUrls.albedo), normal: String(options.auxiliaryModelUrls.normal)},
    maxTileSize: options.maxTileSize, engine: options.engine ?? 'auto', precision: options.precision ?? 'auto',
    dynamicTile: tile === false ? false : {minTileSize: typeof tile === 'object' ? tile.minTileSize ?? 256 : 256,
      initialTileSize: typeof tile === 'object' ? tile.initialTileSize ?? 432 : 432,
      targetTileTimeMs: typeof tile === 'object' ? tile.targetTileTimeMs ?? 16 : 16,
      adjustmentStep: typeof tile === 'object' ? tile.adjustmentStep ?? 16 : 16}
  });
}
