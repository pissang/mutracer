import { setSettings, useViewer } from '../store';
import { Select } from './ui/controls';

export function DenoiserSelect({ disabled = false }: { disabled?: boolean }) {
  const settings = useViewer(state => state.settings);
  const webgl = useViewer(state => state.backend.name === 'WebGL 2');
  const dlssAvailable = useViewer(state => state.nativeCapabilities?.dlssRR);
  const dlss = useViewer(state => state.nativeRayReconstruction);
  return <Select
    label="Denoiser type"
    disabled={disabled}
    value={dlssAvailable && dlss ? 'dlss' : webgl || settings.denoiseModel === 'jnlm' ? 'jnlm' : 'oidn'}
    options={[
      { value: 'oidn', label: 'OIDN', disabled: webgl, hint: webgl ? 'Requires WebGPU' : undefined },
      { value: 'jnlm', label: 'JNLM' },
      ...(dlssAvailable ? [{ value: 'dlss', label: 'DLSS RR', hint: 'Ray Reconstruction' }] : [])
    ]}
    onChange={value => {
      if (dlssAvailable) useViewer.setState({ nativeRayReconstruction: value === 'dlss' });
      if (value !== 'dlss') setSettings({ denoiseModel: value === 'jnlm' ? 'jnlm' : settings.oidnModel });
    }}
  />;
}
