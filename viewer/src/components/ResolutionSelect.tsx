import { RESOLUTION_HEIGHTS, setSettings, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { Select } from './ui/controls';

const SCALES = [0.25, 0.5, 0.75, 1];
const heightLabel = (height: number) => height === 2160 ? '4K' : `${height}p`;

/** Render resolution, as a share of the viewport or a fixed height that keeps the viewport's shape. */
export function ResolutionSelect({ prefix }: { prefix?: string }) {
  const scale = useViewer((s) => s.settings.resolutionScale);
  const height = useViewer((s) => s.settings.resolutionHeight);
  // Rerenders with the stats, which change whenever the canvas is resized.
  useViewer((s) => s.stats.width);
  const canvas = getEngine()?.engine.display.canvas;
  const size = (value: number) => canvas ? `${Math.round(canvas.width * value)}×${Math.round(canvas.height * value)}` : undefined;
  const scales = [...new Set([...SCALES, scale])].sort((a, b) => a - b);
  const heights = [...new Set([...RESOLUTION_HEIGHTS, ...(height === null ? [] : [height])])].sort((a, b) => a - b);
  return (
    <Select
      label="Render resolution"
      prefix={prefix}
      value={height === null ? String(scale) : `${height}p`}
      options={[
        ...scales.map((value) => ({ value: String(value), label: `${Math.round(value * 100)}%`, hint: size(value) })),
        ...heights.map((value) => ({ value: `${value}p`, label: heightLabel(value), hint: canvas ? size(value / canvas.height) : undefined }))
      ]}
      onChange={(value) => setSettings(value.endsWith('p')
        ? { resolutionHeight: parseInt(value) }
        : { resolutionHeight: null, resolutionScale: Number(value) })}
    />
  );
}
