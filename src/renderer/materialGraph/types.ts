/** Numeric port encodings retain MaterialX's distinct color and vector semantics. */
export type GraphType = 'float' | 'integer' | 'boolean' | 'color3' | 'color4' | 'vector2' | 'vector3' | 'vector4' | 'filename' | 'string';
export const width = (type: GraphType) => type === 'vector2' ? 2 : type === 'vector3' || type === 'color3' ? 3 : type === 'vector4' || type === 'color4' ? 4 : 1;
