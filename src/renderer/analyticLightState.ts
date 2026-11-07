import type {AnalyticLightState as NativeAnalyticLightState} from '../scene/lightState.js';
import type DiskLight from '../scene/DiskLight.js';
import type CylinderLight from '../scene/CylinderLight.js';
export type AnalyticLightState = NativeAnalyticLightState | DiskLight | CylinderLight;
