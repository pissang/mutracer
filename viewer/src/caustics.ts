import type {CausticSettings} from '@meimu/mutracer';
import type {Settings} from './store';
type CausticFields=Pick<Settings,'caustics'|'causticLightTracing'|'causticPhotonMapping'>;
/** The same estimator choices drive preview, export and generated code. */
export function causticOptions(s:CausticFields):CausticSettings|undefined {
 return s.caustics?{lightTracing:s.causticLightTracing,photonMapping:s.causticPhotonMapping}:undefined;
}
