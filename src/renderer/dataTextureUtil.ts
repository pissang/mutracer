import { Texture2D, constants } from './textureData.js';

export function padArray(
  typedArray: Float32Array | Int32Array,
  length: number
): Float32Array | Int32Array {
  const newArray = new (typedArray as any).constructor(length);
  newArray.set(typedArray);
  return newArray;
}

export function textureDimensionsFromArray(count: number) {
  const columnsLog = Math.round(Math.log2(Math.sqrt(count)));
  const columns = 2 ** columnsLog;
  const rows = Math.ceil(count / columns);
  return {
    columnsLog,
    columns,
    rows,
    size: rows * columns
  };
}
export function setDataTexture(
  texture: Texture2D,
  dataArray: Float32Array | Int32Array,
  channels: 1 | 2 | 3 | 4
) {
  const textureDim = textureDimensionsFromArray(dataArray.length / channels);
  texture.source = {
    data: padArray(dataArray, textureDim.size * channels),
    width: textureDim.columns,
    height: textureDim.rows
  };
  return textureDim;
}

export const commonLinearFloatProps = {
  wrapS: constants.CLAMP_TO_EDGE,
  wrapT: constants.CLAMP_TO_EDGE,
  // TODO HALF_FLOAT needs Uint16Array. Float32Array not work
  type: constants.FLOAT,
  minFilter: constants.LINEAR,
  magFilter: constants.LINEAR,
  flipY: false,
  useMipmap: false
};

export const commonNearestFloatProps = {
  wrapS: constants.CLAMP_TO_EDGE,
  wrapT: constants.CLAMP_TO_EDGE,
  minFilter: constants.NEAREST,
  magFilter: constants.NEAREST,
  type: constants.FLOAT,
  flipY: false,
  useMipmap: false
};
