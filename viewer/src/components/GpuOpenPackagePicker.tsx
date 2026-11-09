import { GPUOPEN_PACKAGE_LIMIT, type GpuOpenPackage } from '../engine/gpuOpen';
import { Segmented, Select } from './ui/controls';

export function GpuOpenPackagePicker({ packages, value, onChange, disabled }: {
  packages: GpuOpenPackage[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const variants = packages.map(pkg => {
    const match = /^(\d+k)\s+(\d+b)$/i.exec(pkg.label.trim());
    return { pkg, resolution: match?.[1].toLowerCase(), depth: match?.[2].toLowerCase() };
  });
  const selected = variants.find(v => v.pkg.id === value);
  if (!packages.length) return <span>No packages available</span>;
  // Keep packages with unfamiliar upstream labels selectable.
  if (variants.some(v => !v.resolution || !v.depth)) return (
    <Select label="Material package" value={value} disabled={disabled} onChange={onChange}
      options={packages.map(p => ({ value: p.id, label: `${p.label} · ${p.size}${p.bytes > GPUOPEN_PACKAGE_LIMIT ? ' · exceeds 128 MB' : ''}` }))} />
  );
  const resolutions = [...new Set(variants.map(v => v.resolution!))].sort((a, b) => parseInt(a) - parseInt(b));
  const depths = [...new Set(variants.map(v => v.depth!))].sort((a, b) => parseInt(a) - parseInt(b));
  return (
    <>
      <div className="gpuopen-package-controls">
        <Segmented label="Material resolution" value={selected?.resolution ?? ''} disabled={disabled}
          options={resolutions.map(resolution => ({ value: resolution, label: resolution }))}
          onChange={resolution => {
            const next = variants.find(v => v.resolution === resolution && v.depth === selected?.depth)
              ?? variants.find(v => v.resolution === resolution);
            if (next) onChange(next.pkg.id);
          }} />
        <Segmented label="Material bit depth" value={selected?.depth ?? ''} disabled={disabled}
          options={depths.map(depth => ({ value: depth, label: depth,
            disabled: !variants.some(v => v.resolution === selected?.resolution && v.depth === depth) }))}
          onChange={depth => {
            const next = variants.find(v => v.resolution === selected?.resolution && v.depth === depth);
            if (next) onChange(next.pkg.id);
          }} />
      </div>
      {selected && <span>{selected.pkg.size}{selected.pkg.bytes > GPUOPEN_PACKAGE_LIMIT ? ' · exceeds 128 MB' : ''}</span>}
    </>
  );
}
