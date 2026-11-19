import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseMaterialX } from '../../src/materialx';

it('reads the native video patina fixture as an OpenPBR graph with a connected amount', () => {
  const fixture = new URL('../../native/cli/examples/patina.mtlx', import.meta.url);
  const material = parseMaterialX(readFileSync(fixture, 'utf8'));
  expect(material.warnings).toEqual([]);
  expect(material.values.baseMetalness).toBeCloseTo(0.75);
  expect(material.graph?.nodes.some(node => node.id === 'Patina/interface/amount')).toBe(true);
  expect(material.graph?.terminal.baseColor).toBeDefined();
});
