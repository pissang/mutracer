// CPU texture containers shared by atlas packing and the WebGL backend.
export const constants = {
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  UNSIGNED_BYTE: 0x1401,
  RGBA: 0x1908,
  LINEAR: 0x2601,
  NEAREST: 0x2600,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  SCISSOR_TEST: 0x0c11,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  LINES: 0x0001,
  TEXTURE_2D: 0x0de1,
  TEXTURE_2D_ARRAY: 0x8c1a
} as const;

export type TextureImageSource = any;
export interface TexturePixelSource {
  data: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray | Uint16Array;
  width: number;
  height: number;
}
type TextureSource = TextureImageSource | TexturePixelSource;

export interface TextureOptions {
  source?: TextureSource | TextureImageSource[];
  width?: number;
  height?: number;
  type?: number;
  minFilter?: number;
  magFilter?: number;
  wrapS?: number;
  wrapT?: number;
  flipY?: boolean;
  flipYArray?: boolean[];
  useMipmap?: boolean;
  premultiplyAlpha?: boolean;
  sRGB?: boolean;
}

function isPixelSource(source: unknown): source is TexturePixelSource {
  return !!source && typeof source === 'object' && 'data' in source;
}

export class Texture2D {
  private _source?: TextureSource | TextureImageSource[];
  width = 1;
  height = 1;
  // Keep the shared texture container constructible in DOM-free WebGPU hosts.
  target: number = constants.TEXTURE_2D;
  protected _options: TextureOptions;
  protected _texture?: WebGLTexture;
  protected _dirty = true;
  protected _allocated = false;

  constructor(options: TextureOptions = {}) {
    this._options = options;
    this.source = options.source;
    this.width = options.width || 1;
    this.height = options.height || 1;
  }

  get storageType() {return this._options.type ?? constants.UNSIGNED_BYTE;}
  get isByteEncoded() { return (this._options.type ?? constants.UNSIGNED_BYTE) === constants.UNSIGNED_BYTE; }

  /** Allocated 2D render-target payload, excluding driver/FBO overhead. */
  getMemoryBytes() {
    if (!this._allocated) return 0;
    const bytes = this._options.type === constants.FLOAT ? 4 :
      this._options.type === constants.HALF_FLOAT ? 2 : 1;
    return this.width * this.height * 4 * bytes;
  }

  get source(): any {
    return this._source;
  }

  set source(value: any) {
    if (this._source !== value) {
      this._source = value;
      this._dirty = true;
      this._allocated = false;
    }
  }

  dirty() {
    this._dirty = true;
  }

  resize(width: number, height: number) {
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this._dirty = true;
      this._allocated = false;
    }
  }

  ensureStorage(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    options: TextureOptions = this._options
  ) {
    const storageChanged = (this._options.type ?? constants.UNSIGNED_BYTE) !== (options.type ?? this._options.type ?? constants.UNSIGNED_BYTE) ||
      this._options.sRGB !== (options.sRGB ?? this._options.sRGB);
    this._options = { ...this._options, ...options };
    if (storageChanged) {this._dirty = true; this._allocated = false;}
    this.resize(Math.max(1, width), Math.max(1, height));
    this._ensureTexture(gl);
    if (!this._allocated || this._dirty) {
      this._bindAndConfigure(gl);
      const { internalFormat, format, type } = this._format(gl);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        this.width,
        this.height,
        0,
        format,
        type,
        null
      );
      this._allocated = true;
      this._dirty = false;
    }
    return this;
  }

  bind(gl: WebGL2RenderingContext, unit: number) {
    this._ensureTexture(gl);
    gl.activeTexture(gl.TEXTURE0 + unit);
    this._bindAndConfigure(gl);
    if (this._dirty || !this._allocated) {
      this._upload(gl);
    }
  }

  /** Copies a byte range into a data texture's CPU image and uploads its covering rows. */
  updateDataRange(gl: WebGL2RenderingContext, data: Float32Array | Int32Array | Uint8Array,
    offset: number, size: number) {
    if (!size) return;
    const source = this.source as TexturePixelSource;
    if (!isPixelSource(source) || offset < 0 || size < 0 ||
      offset % data.BYTES_PER_ELEMENT || size % data.BYTES_PER_ELEMENT ||
      offset + size > data.byteLength || offset + size > source.data.byteLength) {
      throw new RangeError('Invalid data texture byte range');
    }
    source.data.set(data.subarray(offset / data.BYTES_PER_ELEMENT, (offset + size) / data.BYTES_PER_ELEMENT),
      offset / source.data.BYTES_PER_ELEMENT);
    this._ensureTexture(gl);
    this._bindAndConfigure(gl);
    if (this._dirty || !this._allocated) { this._upload(gl); return; }
    const channels = source.data.length / (source.width * source.height);
    const rowBytes = source.width * channels * source.data.BYTES_PER_ELEMENT;
    const first = Math.floor(offset / rowBytes), end = Math.ceil((offset + size) / rowBytes);
    const { format, type } = this._format(gl, channels);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._options.flipY ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this._options.premultiplyAlpha ? 1 : 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, source.width, end - first, format, type,
      source.data.subarray(first * source.width * channels, end * source.width * channels));
  }

  /** Coalesce ranges whose covering texture rows overlap before enqueuing uploads. */
  updateDataRanges(gl: WebGL2RenderingContext, data: Float32Array | Int32Array | Uint8Array,
    ranges: Iterable<{offset: number; size: number}>) {
    const source = this.source as TexturePixelSource;
    if (!isPixelSource(source)) throw new RangeError('Data texture requires pixel storage');
    const rowBytes = source.data.byteLength / source.height;
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
    let first = 0, end = 0;
    for (const range of sorted) {
      if (range.offset < 0 || range.size < 0 || range.offset % data.BYTES_PER_ELEMENT ||
        range.size % data.BYTES_PER_ELEMENT || range.offset + range.size > data.byteLength ||
        range.offset + range.size > source.data.byteLength) throw new RangeError('Invalid data texture byte range');
    }
    for (const range of sorted) {
      if (!range.size) continue;
      if (end > first && Math.floor(range.offset / rowBytes) > Math.ceil(end / rowBytes)) {
        this.updateDataRange(gl, data, first, end - first); first = end = 0;
      }
      if (end === first) first = range.offset;
      end = Math.max(end, range.offset + range.size);
    }
    if (end > first) this.updateDataRange(gl, data, first, end - first);
  }

  getWebGLTexture(gl: WebGL2RenderingContext) {
    this._ensureTexture(gl);
    return this._texture!;
  }

  dispose(gl: WebGL2RenderingContext) {
    if (this._texture) gl.deleteTexture(this._texture);
    this._texture = undefined; this._allocated = false; this._dirty = true;
  }

  protected _ensureTexture(gl: WebGL2RenderingContext) {
    if (!this._texture) {
      this._texture = gl.createTexture()!;
      this._dirty = true;
      this._allocated = false;
    }
  }

  protected _bindAndConfigure(gl: WebGL2RenderingContext) {
    gl.bindTexture(gl.TEXTURE_2D, this._texture!);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      this._options.minFilter || gl.NEAREST
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      this._options.magFilter || gl.NEAREST
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      this._options.wrapS || gl.CLAMP_TO_EDGE
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_T,
      this._options.wrapT || gl.CLAMP_TO_EDGE
    );
  }

  protected _format(gl: WebGL2RenderingContext, channels = 4) {
    const type = this._options.type || gl.UNSIGNED_BYTE;
    if (type === gl.UNSIGNED_INT) return {type, format: gl.RGBA_INTEGER, internalFormat: gl.RGBA32UI};
    const formats = [gl.RED, gl.RG, gl.RGB, gl.RGBA];
    const floatFormats = [gl.R32F, gl.RG32F, gl.RGB32F, gl.RGBA32F];
    const halfFloatFormats = [gl.R16F, gl.RG16F, gl.RGB16F, gl.RGBA16F];
    return {
      type,
      format: formats[channels - 1],
      internalFormat:
        type === gl.FLOAT
          ? floatFormats[channels - 1]
          : type === gl.HALF_FLOAT
            ? halfFloatFormats[channels - 1]
            : this._options.sRGB
              ? gl.SRGB8_ALPHA8
              : gl.RGBA8
    };
  }

  protected _upload(gl: WebGL2RenderingContext) {
    const source = this.source;
    const channels =
      source && isPixelSource(source)
        ? source.data.byteLength / source.data.BYTES_PER_ELEMENT / (source.width * source.height)
        : 4;
    const { internalFormat, format, type } = this._format(gl, channels);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._options.flipY ? 1 : 0);
    gl.pixelStorei(
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      this._options.premultiplyAlpha ? 1 : 0
    );
    if (source && isPixelSource(source)) {
      this.width = source.width;
      this.height = source.height;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        source.width,
        source.height,
        0,
        format,
        type,
        source.data
      );
    } else if (source && !Array.isArray(source)) {
      this.width = source.width;
      this.height = source.height;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        format,
        type,
        source
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        this.width,
        this.height,
        0,
        format,
        type,
        null
      );
    }
    if (this._options.useMipmap) gl.generateMipmap(gl.TEXTURE_2D);
    this._dirty = false;
    this._allocated = true;
  }
}

export class Texture2DArray extends Texture2D {
  target: number = constants.TEXTURE_2D_ARRAY;

  get flipYArray() {
    return this._options.flipYArray || [];
  }

  protected _bindAndConfigure(gl: WebGL2RenderingContext) {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._texture!);
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_MIN_FILTER,
      this._options.minFilter || gl.LINEAR
    );
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_MAG_FILTER,
      this._options.magFilter || gl.LINEAR
    );
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_WRAP_S,
      this._options.wrapS || gl.CLAMP_TO_EDGE
    );
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_WRAP_T,
      this._options.wrapT || gl.CLAMP_TO_EDGE
    );
  }

  protected _upload(gl: WebGL2RenderingContext) {
    const sources = (this.source || []) as TextureImageSource[];
    const depth = Math.max(1, sources.length);
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxTextureArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    if (
      this.width > maxTextureSize ||
      this.height > maxTextureSize ||
      depth > maxTextureArrayLayers
    ) {
      throw new Error(
        `Texture array ${this.width}x${this.height}x${depth} exceeds WebGL limits ${maxTextureSize}x${maxTextureSize}x${maxTextureArrayLayers}.`
      );
    }
    const type = this.storageType;
    const internalFormat = type === gl.HALF_FLOAT ? gl.RGBA16F
      : type === gl.FLOAT ? gl.RGBA32F
      : this._options.sRGB ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    // Attribute allocation errors to this upload rather than an unrelated
    // earlier WebGL call whose error flag was never consumed.
    while (gl.getError() !== gl.NO_ERROR) {
      // Drain the context error queue.
    }
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      internalFormat,
      this.width,
      this.height,
      depth,
      0,
      gl.RGBA,
      type,
      null
    );
    const allocationError = gl.getError();
    if (allocationError !== gl.NO_ERROR) {
      throw new Error(
        `WebGL could not allocate texture array ${this.width}x${this.height}x${depth} (error 0x${allocationError.toString(16)}).`
      );
    }
    sources.forEach((source, index) => {
      gl.pixelStorei(
        gl.UNPACK_FLIP_Y_WEBGL,
        (this._options.flipYArray?.[index] ?? this._options.flipY) ? 1 : 0
      );
      // Material maps use straight alpha. Do not inherit a premultiplication
      // state from a texture uploaded earlier on the same WebGL context.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        index,
        source.width,
        source.height,
        1,
        gl.RGBA,
        type,
        isPixelSource(source) ? source.data : source
      );
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) {
        throw new Error(`WebGL could not upload texture array layer ${index} (error 0x${uploadError.toString(16)}).`);
      }
    });
    this._dirty = false;
    this._allocated = true;
  }

  bind(gl: WebGL2RenderingContext, unit: number) {
    this._ensureTexture(gl);
    gl.activeTexture(gl.TEXTURE0 + unit);
    this._bindAndConfigure(gl);
    if (this._dirty || !this._allocated) this._upload(gl);
  }
}

/** Compiled GLSL program plus its current bind-group-like values. */
