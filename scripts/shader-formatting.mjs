import ts from 'typescript';
import { createShaderIdentifierMap, readShaderSourceFiles, renameShaderIdentifiers } from './shader-identifiers.mjs';
import { isRendererSource, shaderTemplateLanguage, shaderTemplateParts } from './shader-template-context.mjs';

// Keep directive boundaries and token separation while compacting punctuation.
// The NUL separator stands for a template interpolation; comments containing
// one stay intact so an interpolation inside a comment cannot become code.
export function stripShaderFormatting(source, trimFirstLine = true) {
  let result = '';
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
    } else if (source.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      // Preserve malformed input so shader validation still reports it.
      if (depth > 0) { result += source.slice(start); break; }
    } else if (source[i] === '"' || source[i] === "'") {
      // Preserve quoted preprocessor operands, including URLs and escapes.
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === quote) break;
      }
      result += source.slice(start, i);
      continue;
    } else {
      result += source[i++];
      continue;
    }
    const comment = source.slice(start, i);
    result += comment.includes('\0') ? comment
      : comment.startsWith('/*') ? ' ' + comment.replace(/[^\r\n]/g, '') : '';
  }
  result = trimFirstLine ? result.replace(/^[\t ]+/gm, '')
    : result.replace(/([\r\n])[\t ]+/g, '$1');
  return compactShaderWhitespace(result);
}

// Tokens that can be accidentally created by joining separated punctuation.
const joinedOperators = new Set(['++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->', '//', '/*', '*/']);
const punctuation = /^[+\-*/%&|^!<>=?:;,(){}\[\].@]$/;
function compactShaderWhitespace(source) {
  let result = '', previous = '', spaces = '', directive = false, lineStart = true;
  let blank = false;
  for (let i = 0; i < source.length;) {
    const start = i, char = source[i];
    if (char === '\r' || char === '\n') {
      const newline = char === '\r' && source[i + 1] === '\n' ? '\r\n' : char;
      // A continued macro may intentionally end with a blank line.
      const continued = directive && previous === '\\';
      if (!blank || continued) result += spaces + newline;
      blank = !previous && !continued;
      i += newline.length; previous = ''; spaces = ''; lineStart = true; directive = continued;
      continue;
    }
    if (char === ' ' || char === '\t') {spaces += char; i++; continue;}
    if (lineStart && char === '#') directive = true;
    if (char === '"' || char === "'") {
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === quote) break;
      }
    } else if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      // Only comments containing interpolation (or malformed comments) remain.
      // Keep their entire text, so interpolation never escapes its comment.
      if (source.startsWith('//', i)) while (i < source.length && !/[\r\n]/.test(source[i])) i++;
      else {
        let depth = 1; i += 2;
        while (i < source.length && depth) {
          if (source.startsWith('/*', i)) {depth++; i += 2;}
          else if (source.startsWith('*/', i)) {depth--; i += 2;}
          else i++;
        }
      }
    } else if (/[A-Za-z0-9_]/.test(char)) {
      // Words/numbers remain intact; their internal punctuation is visited later.
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
    } else i++;
    const token = source.slice(start, i);
    const a = previous.at(-1), b = token[0];
    const numericDot = (a === '.' && /\d/.test(b)) || (/\d/.test(a ?? '') && b === '.');
    const removable = !directive && previous && token !== '\0' && previous !== '\0' &&
      (punctuation.test(a) || punctuation.test(b)) && !numericDot && !joinedOperators.has(a + b);
    result += (removable ? '' : spaces) + token;
    previous = token; spaces = ''; lineStart = false; blank = false;
  }
  return result + spaces;
}

/** Only shader modules and explicitly marked/tagged shader templates are
 * transformed. Ordinary JS strings, imports and source license comments stay
 * untouched. The same transformer is used by ESM, Vite and contract tests. */
export function createShaderFormattingTransformer(identifiers = new Map()) {
  return context => sourceFile => {
    const filename = sourceFile.fileName.replace(/\\/g, '/');
    if (!isRendererSource(filename)) return sourceFile;
    const original = (replacement, node) =>
      ts.setTextRange(ts.setOriginalNode(replacement, node), node);
    function visit(node, inherited) {
      if (ts.isTaggedTemplateExpression(node)) {
        // glsl reads cooked strings; other tags may inspect raw source.
        if (!ts.isIdentifier(node.tag) || node.tag.text !== 'glsl') return node;
        return ts.factory.updateTaggedTemplateExpression(node, node.tag,
          node.typeArguments, visit(node.template, 'glsl'));
      }
      const isTemplate = ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      const language = isTemplate && shaderTemplateLanguage(node, sourceFile, inherited);
      if (isTemplate && language) {
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
          // A fragment may be inserted mid-line. Its initial spaces can be
          // required token separators; only remove indentation after newlines.
          const text = renameShaderIdentifiers(stripShaderFormatting(node.text, false), identifiers);
          return text === node.text ? node : original(ts.factory.createNoSubstitutionTemplateLiteral(text), node);
        }
        const parts = shaderTemplateParts(node);
        // Shader source cannot contain NUL. Fail instead of corrupting a template.
        if (parts.some(part => part.includes('\0'))) throw new Error(`NUL in shader template: ${filename}`);
        const compact = renameShaderIdentifiers(stripShaderFormatting(parts.join('\0'), false), identifiers).split('\0');
        const head = compact[0] === node.head.text ? node.head
          : original(ts.factory.createTemplateHead(compact[0]), node.head);
        const spans = node.templateSpans.map((span, index) => {
          const text = compact[index + 1];
          const literal = text === span.literal.text ? span.literal : original(
            ts.isTemplateTail(span.literal) ? ts.factory.createTemplateTail(text)
              : ts.factory.createTemplateMiddle(text), span.literal);
          return ts.factory.updateTemplateSpan(span, visit(span.expression, language), literal);
        });
        return ts.factory.updateTemplateExpression(node, head, spans);
      }
      return ts.visitEachChild(node, child => visit(child, inherited), context);
    }
    return visit(sourceFile);
  };
}

export function shaderFormattingPlugin({ sourceRoot } = {}) {
  let identifiers;
  return {
    name: 'mutracer-shader-formatting',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      const files = readShaderSourceFiles(sourceRoot);
      for (const file of files) this.addWatchFile(file.filename);
      identifiers = createShaderIdentifierMap(files);
    },
    // A graph change can alter names in otherwise unchanged chunks. Re-run the
    // transform for cached renderer modules during production watch builds.
    shouldTransformCachedModule({ id }) {
      return isRendererSource(id.split('?')[0]);
    },
    transform(source, id) {
      const filename = id.split('?')[0].replace(/\\/g, '/');
      if (!filename.includes('/src/renderer/') || !filename.endsWith('.ts')) return null;
      const result = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          sourceMap: true,
          inlineSources: true
        },
        transformers: { before: [createShaderFormattingTransformer(identifiers ??=
          createShaderIdentifierMap(readShaderSourceFiles(sourceRoot)))] }
      });
      return { code: result.outputText, map: result.sourceMapText };
    }
  };
}
