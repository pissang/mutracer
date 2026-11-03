/** PBRT-v4 grammar reference: mmp/pbrt-v4@b0bdf461, src/pbrt/parser.cpp.
 * This is an independent parser; no renderer or scene assets are bundled. */
export interface Location { file: string; line: number; column: number }
export interface Token extends Location { value: string; quoted: boolean }
export interface Parameter { type: string; name: string; values: (string | number | boolean)[] | Float32Array | Uint32Array; loc: Location }
export interface Statement extends Location { kind: string; args: (string | number)[]; params: Record<string, Parameter> }
export class PbrtError extends Error {
  constructor(message: string, public loc: Location) { super(`${loc.file}:${loc.line}:${loc.column}: ${message}`); this.name = 'PbrtError'; }
}

/** One-token lookahead keeps large inline triangle meshes out of a token array. */
export function* tokenize(text: string, file = '<input>', firstLine = 1): Generator<Token> {
  let offset = 0, line = firstLine, column = 1;
  const advance = () => { const c = text[offset++]; if (c === '\n') { line++; column = 1; } else column++; return c; };
  while (offset < text.length) {
    const c = text[offset];
    if (/\s/.test(c)) { advance(); continue; }
    if (c === '#') { while (offset < text.length && advance() !== '\n') { /* comment */ } continue; }
    const loc = { file, line, column };
    if (c === '[' || c === ']') { yield { ...loc, value: advance(), quoted: false }; continue; }
    if (c === '"') {
      advance(); let value = '', closed = false;
      while (offset < text.length) {
        const next = advance();
        if (next === '"') { closed = true; break; }
        if (next === '\\') {
          if (offset === text.length) break;
          const escaped = advance();
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"' };
          if (!(escaped in escapes)) throw new PbrtError(`Invalid escape \\${escaped}`, loc);
          value += escapes[escaped];
        } else value += next;
      }
      if (!closed) throw new PbrtError('Unterminated string', loc);
      yield { ...loc, value, quoted: true }; continue;
    }
    let value = '';
    while (offset < text.length && !/[\s\[\]"#]/.test(text[offset])) value += advance();
    yield { ...loc, value, quoted: false };
  }
}

const arity: Record<string, number> = {
  AttributeBegin: 0, AttributeEnd: 0, TransformBegin: 0, TransformEnd: 0, WorldBegin: 0, WorldEnd: 0,
  Identity: 0, ReverseOrientation: 0, ObjectEnd: 0, Translate: 3, Scale: 3, Rotate: 4, LookAt: 9,
  Transform: 16, ConcatTransform: 16, TransformTimes: 2, ActiveTransform: 1, CoordinateSystem: 1,
  CoordSysTransform: 1, Include: 1, Import: 1, ObjectBegin: 1, ObjectInstance: 1, NamedMaterial: 1,
  MediumInterface: 2, Texture: 3, Material: 1, MakeNamedMaterial: 1, MakeNamedMedium: 1,
  Shape: 1, LightSource: 1, AreaLightSource: 1, Camera: 1, Film: 1, Sampler: 1, Integrator: 1,
  PixelFilter: 1, Accelerator: 1, ColorSpace: 1, Attribute: 1, Option: 2
};
const numericArgs = new Set(['Translate', 'Scale', 'Rotate', 'LookAt', 'Transform', 'ConcatTransform', 'TransformTimes']);
const numericTypes = new Set(['float', 'integer', 'point', 'point2', 'point3', 'vector', 'vector2', 'vector3', 'normal', 'normal3', 'rgb', 'color', 'blackbody']);
const parameterTypes = new Set([...numericTypes, 'bool', 'string', 'texture', 'spectrum']);

export function* parse(text: string, file = '<input>', firstLine = 1): Generator<Statement> {
  const iterator = tokenize(text, file, firstLine);
  let current = iterator.next().value as Token | undefined;
  const pop = () => { const result = current; current = iterator.next().value as Token | undefined; return result; };
  const fail = (message: string, loc: Location) => { throw new PbrtError(message, current ?? loc); };
  const number = (token: Token) => {
    if (token.quoted || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token.value) || !Number.isFinite(Number(token.value))) throw new PbrtError('Expected finite number', token);
    return Number(token.value);
  };
  while (current) {
    const head = pop()!;
    if (head.quoted || !(head.value in arity)) throw new PbrtError(`Unknown statement ${head.value}`, head);
    const args: (string | number)[] = [];
    const bracket = current?.value === '[' && !current.quoted;
    if (bracket) pop();
    for (let i = 0; i < arity[head.value]; i++) {
      if (head.value === 'MediumInterface' && i === 1 && !current?.quoted) { args.push(args[0]); break; }
      if (!current) fail('Missing statement argument', head);
      const token = pop()!;
      if (numericArgs.has(head.value)) args.push(number(token));
      else {
        if (!token.quoted && head.value !== 'ActiveTransform' && !(head.value === 'Option' && i === 1)) throw new PbrtError('Expected quoted argument', token);
        args.push(token.value);
      }
    }
    if (bracket) { if (current?.value !== ']') fail('Expected closing bracket', head); pop(); }
    const params: Record<string, Parameter> = Object.create(null);
    while (current?.quoted) {
      const declaration = pop()!;
      const match = /^(\S+)\s+(\S+)$/.exec(declaration.value.trim());
      if (!match || !parameterTypes.has(match[1])) throw new PbrtError(`Invalid parameter declaration ${declaration.value}`, declaration);
      const [, type, name] = match;
      // ParameterDictionary searches in reverse declaration order: last wins.
      const values: Parameter['values'] = [];
      const array = current?.value === '[' && !current.quoted;
      if (array) pop();
      do {
        if (!current || (!current.quoted && current.value === ']')) {
          if (array && current?.value === ']') break;
          fail(`Missing value for ${name}`, declaration);
        }
        const token = pop()!;
        if (numericTypes.has(type)) {
          const value = number(token);
          if (type === 'integer' && !Number.isSafeInteger(value)) throw new PbrtError('Expected integer', token);
          values.push(value);
        } else if (type === 'bool') {
          if (token.value !== 'true' && token.value !== 'false') throw new PbrtError('Expected boolean', token);
          values.push(token.value === 'true');
        } else if (type === 'spectrum' && !token.quoted) values.push(number(token));
        else {
          if (!token.quoted) throw new PbrtError('Expected quoted value', token);
          values.push(token.value);
        }
      } while (array && current && (current.quoted || current.value !== ']'));
      if (array) { if (current?.value !== ']') fail('Unterminated parameter array', declaration); pop(); }
      params[name] = { type, name, values, loc: declaration };
    }
    yield { ...head, kind: head.value, args, params };
  }
}
