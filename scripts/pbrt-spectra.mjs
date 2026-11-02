// Derive the compact conversion tables from the pinned Apache-2.0 PBRT source.
import { readFile, writeFile } from 'node:fs/promises';
const root = process.argv[2] ?? `${process.env.HOME}/.codex/tools/pbrt-v4`;
const source = await readFile(`${root}/src/pbrt/util/spectrum.cpp`, 'utf8');
const arrays = Object.fromEntries([...source.matchAll(/const Float\s+(\w+)\[[^\]]*\]\s*=\s*\{([\s\S]*?)\};/g)].map(([, name, body]) => [name, body.replace(/\/\/[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean).map(Number)]));
const table = {};
for (const name of ['CIE_X', 'CIE_Y', 'CIE_Z', 'CIE_lambda', 'CIE_Illum_D6500']) table[name] = arrays[name];
const variables = Object.fromEntries([...source.matchAll(/Spectrum\s+(\w+)\s*=\s*PiecewiseLinearSpectrum::FromInterleaved\((\w+),/g)].map(([, variable, array]) => [variable, array]));
for (const [, name, variable] of source.matchAll(/\{"((?:metal|glass|stdillum)-[^"]+)",\s*(\w+)\}/g)) if (arrays[variables[variable]]) table[name] = arrays[variables[variable]];
if (!table['metal-Au-eta'] || !table['glass-BK7']) throw new Error('Missing spectral data');
await writeFile('tools/pbrt/spectra-data.json', JSON.stringify(table) + '\n');
