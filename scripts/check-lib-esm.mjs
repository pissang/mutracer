// Import without browser globals to verify all relative ESM paths resolve.
const library = await import('../lib/main.js');
for (const name of ['Engine', 'Display', 'Render']) if (typeof library[name] !== 'function') throw new Error(`Missing ${name} export`);
if ('Renderer' in library) throw new Error('Removed Renderer export is still exposed');
console.log(`Library ESM resolves in Node (${Object.keys(library).length} exports).`);
const adapter = await import('@meimu/mutracer/three');
for (const name of ['THREESync', 'fromTHREEScene', 'fromTHREECamera']) {
  if (typeof adapter[name] !== 'function' || name in library) throw new Error(`Unexpected Three.js adapter export: ${name}`);
}

// Inspect every declaration, including re-exported and implementation modules.
const { readdirSync, readFileSync } = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { default: ts } = await import('typescript');
const declarationsRoot = fileURLToPath(new URL('../lib/', import.meta.url));
function checkDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { checkDeclarations(file); continue; }
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(file, 'utf8');
    if (source.includes('@internal')) throw new Error(`Internal declaration leaked: ${file}`);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      const member = ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isPropertySignature(node) || ts.isMethodSignature(node);
      if (member && node.name?.getText(ast).replace(/^['"]|['"]$/g, '').startsWith('_') &&
        !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) {
        throw new Error(`Public underscore member leaked: ${file}: ${node.name.getText(ast)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
checkDeclarations(declarationsRoot);
console.log('Library declarations contain no @internal or public underscore members.');

const oidn = await import('../lib/oidn.js');
const oidnExports = ['OIDN_MODEL_FILENAMES', 'OIDN_AUXILIARY_MODEL_FILENAMES',
  'OIDN_WEIGHTS_PACKAGE', 'OIDN_WEIGHTS_PACKAGE_VERSION',
  'DEFAULT_OIDN_WEIGHTS_BASE_URL', 'DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL',
  'resolveOIDNModelUrl', 'resolveOIDNAuxiliaryModelUrls'].sort();
if (JSON.stringify(Object.keys(oidn).sort()) !== JSON.stringify(oidnExports)) throw new Error('Unexpected OIDN runtime exports.');
console.log('OIDN ESM resolves in Node with only constants and URL helpers.');

// Follow static dependencies only: Render intentionally loads OIDN with import().
const visited = new Set();
function checkStaticDependencies(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const name = specifier.text;
    if (/^oidn-web(?:gpu)?(?:\/|$)/.test(name)) throw new Error(`Static OIDN dependency in ${file}.`);
    if (name === 'three' || name.startsWith('three/')) throw new Error(`Static Three.js dependency in ${file}.`);
    if (name.startsWith('.') && name.endsWith('.js')) {
      const target = path.resolve(path.dirname(file), name);
      checkStaticDependencies(file.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target);
    }
  }
}
checkStaticDependencies(path.join(declarationsRoot, 'main.js'));
console.log('Main ESM static dependency graph does not import oidn-webgpu.');
checkStaticDependencies(path.join(declarationsRoot, 'main.d.ts'));
console.log('Main declaration dependency graph does not import oidn-webgpu.');
