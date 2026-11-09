export type ShaderDefineValue = string | number | boolean | null;

export interface ShaderUniform<T = unknown> {
  type: string;
  value?: T;
  len?: string | number;
  array?: boolean;
}

export interface ShaderMixin {
  defines: Record<string, ShaderDefineValue>;
  uniforms: Record<string, ShaderUniform>;
  main: string;
  functions?: Array<(name?: string) => string>;
}

export function glsl(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce(
    (result, part, index) =>
      result + (index ? String(values[index - 1] ?? '') : '') + part,
    ''
  );
}

export function createShaderMixin(
  options: Partial<ShaderMixin> | string
): ShaderMixin {
  if (typeof options === 'string') {
    options = { main: options };
  }
  return {
    defines: options.defines || {},
    uniforms: options.uniforms || {},
    main: options.main || '',
    functions: options.functions || []
  };
}

export class Shader {
  static uniform<T>(type: string, value?: T): ShaderUniform<T> {
    return { type, value };
  }

  static arrayUniform<T>(
    type: string,
    len: string | number,
    value?: T
  ): ShaderUniform<T> {
    return { type, len, value, array: true };
  }
}

export interface FragmentShaderOptions {
  name?: string;
  outputs?: string[];
  outputTypes?: Record<string, 'vec4' | 'uvec4'>;
  defines?: Record<string, ShaderDefineValue>;
  uniforms?: Record<string, ShaderUniform>;
  includes?: ShaderMixin[];
  main: string;
}

export class FragmentShader<
  TDefines extends Record<string, ShaderDefineValue> = Record<
    string,
    ShaderDefineValue
  >,
  TUniforms extends Record<string, ShaderUniform> = Record<
    string,
    ShaderUniform
  >
> {
  readonly name: string;
  readonly outputs: string[];
  readonly outputTypes: Record<string, 'vec4' | 'uvec4'>;
  readonly defines: TDefines;
  readonly uniforms: TUniforms;
  readonly functions: Array<(name?: string) => string>;
  readonly main: string;
  parallelCompile = false;

  constructor(options: FragmentShaderOptions) {
    const includes = options.includes || [];
    this.name = options.name || '';
    this.outputs = options.outputs || ['color'];
    this.outputTypes = options.outputTypes ?? {};
    this.defines = Object.assign(
      {},
      ...includes.map((item) => item.defines),
      options.defines || {}
    ) as TDefines;
    this.uniforms = Object.assign(
      {},
      ...includes.map((item) => item.uniforms),
      options.uniforms || {}
    ) as TUniforms;
    this.functions = includes.flatMap((item) => item.functions || []);
    this.main = options.main;
  }
}
