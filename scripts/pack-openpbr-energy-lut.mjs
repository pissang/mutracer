// Write the canonical Apache-2.0 Adobe-derived row deltas as the browser asset,
// byte for byte (directional deltas, then Uint16 averages); no re-quantizing.
import {readFileSync, writeFileSync} from 'node:fs';
import ts from 'typescript';
const input = new URL('../src/renderer/openPbrEnergyLut.ts', import.meta.url);
const output = new URL('../src/renderer/openPbrEnergyLut.bin', import.meta.url);
const source = readFileSync(input, 'utf8');
const ast = ts.createSourceFile(input.pathname, source, ts.ScriptTarget.Latest, true);
const data = new Map();
for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name.getText(ast);
    if (!name.endsWith('_BASE64')) continue;
    let encoded = '';
    const visit = node => {if (ts.isStringLiteral(node)) encoded += node.text; else ts.forEachChild(node, visit);};
    visit(declaration.initializer);
    data.set(name, Buffer.from(encoded, 'base64'));
  }
}
const directional = Buffer.concat(['OPENPBR_ENERGY_LUT_ROW_DELTA_BASE64', 'OPENPBR_METAL_ENERGY_LUT_ROW_DELTA_BASE64', 'OPENPBR_DIELECTRIC_ENERGY_LUT_ROW_DELTA_BASE64'].map(name => data.get(name)));
const averages = Buffer.concat(['OPENPBR_METAL_AVERAGE_U16_BASE64', 'OPENPBR_DIELECTRIC_AVERAGE_U16_BASE64'].map(name => data.get(name)));
const packed = Buffer.concat([directional, averages]);
if (process.argv.includes('--check')) {
  if (!readFileSync(output).equals(packed)) throw new Error('OpenPBR energy table asset is stale');
} else writeFileSync(output, packed);
console.log(`OpenPBR deltas: ${directional.length} + ${averages.length} bytes`);
