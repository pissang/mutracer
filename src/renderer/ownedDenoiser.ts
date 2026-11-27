import type {JNLMDenoiser} from './jnlm.js';
import type {OIDNDenoiser} from './oidnNetwork.js';

// Keep concrete OIDN types out of the public declaration graph: diagnostics
// depend on denoiser.ts, but only Engine/Render own network implementations.
export type OwnedDenoiser =
  | {kind: 'jnlm'; denoiser: JNLMDenoiser}
  | {kind: 'oidn'; denoiser: OIDNDenoiser; sceneLinear: boolean};
