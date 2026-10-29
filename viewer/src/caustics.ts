import type {CausticSettings} from '@meimu/mutracer';
import type {Settings} from './store';
/** The same estimator choices drive preview, export and generated code. */
export function causticOptions(s:Pick<Settings,'caustics'|'causticLightTracing'|'causticPhotonMapping'>):CausticSettings|undefined {
 return s.caustics?{lightTracing:s.causticLightTracing,photonMapping:s.causticPhotonMapping}:undefined;
}
