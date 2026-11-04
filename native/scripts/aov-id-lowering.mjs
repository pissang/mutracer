import ts from 'typescript';

// The browser keeps IDs outside enumerable object state (including snapshots
// made with Object.create). scriptc's weak-key registration/retirement is linear
// per key, so specialize this private storage only in staged native inputs.
export function lowerMeshAovId(source) {
  const file = ts.createSourceFile('MeshState.ts', source, ts.ScriptTarget.Latest, true);
  const f = ts.factory;
  let removed = 0, classes = 0, gets = 0, sets = 0;
  const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const declaration = node.declarationList.declarations[0];
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'aovIds'
          && declaration.initializer && ts.isNewExpression(declaration.initializer)
          && declaration.initializer.expression.getText(file) === 'WeakMap') {
        removed++;
        return undefined;
      }
    }
    if (ts.isClassDeclaration(node) && node.name?.text === 'MeshState') {
      classes++;
      const updated = ts.visitEachChild(node, visit, context);
      return f.updateClassDeclaration(updated, updated.modifiers, updated.name,
        updated.typeParameters, updated.heritageClauses, [
          f.createPropertyDeclaration([f.createModifier(ts.SyntaxKind.PrivateKeyword)],
            '_nativeAovId', undefined, f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            f.createNumericLiteral(0)), ...updated.members
        ]);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'aovIds') {
      const args = node.arguments;
      if (args[0]?.kind !== ts.SyntaxKind.ThisKeyword) throw new Error('Unexpected mesh AOV key');
      const field = f.createPropertyAccessExpression(f.createThis(), '_nativeAovId');
      if (node.expression.name.text === 'get' && args.length === 1) { gets++; return field; }
      if (node.expression.name.text === 'set' && args.length === 2) {
        sets++;
        return f.createAssignment(field, ts.visitNode(args[1], visit));
      }
      throw new Error('Unexpected mesh AOV operation');
    }
    return ts.visitEachChild(node, visit, context);
  })]);
  try {
    if (removed !== 1 || classes !== 1 || gets !== 1 || sets !== 2)
      throw new Error('Mesh AOV storage changed; review native specialization');
    return ts.createPrinter().printFile(transformed.transformed[0]);
  } finally { transformed.dispose(); }
}
