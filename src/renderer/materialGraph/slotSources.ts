import type Texture from '../../scene/Texture.js';
export const slotSources = new WeakSet<object>();
export function slotTextureSource(texture: Texture) { return slotSources.has(texture) ? texture.image : texture; }
export function slotTextureSources(textures: readonly Texture[]) {
    const images = new Set(textures.filter(texture => slotSources.has(texture)).map(texture => texture.image));
    return (texture: Texture) => images.has(texture.image) ? texture.image : texture;
}

