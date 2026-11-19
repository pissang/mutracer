function locate(object) {
  const path = [];
  for (let node = object; node; node = node.parent) {
    const index = node.parent?.children.indexOf(node);
    path.unshift(node.name ? `${node.type} "${node.name}"` : `${node.type}${index === undefined ? '' : `[${index}]`}`);
  }
  return path.join(' / ');
}

export function strictConversion(scene, convert) {
  if (scene.fog) throw new Error(`${locate(scene)}: ${scene.fog.type ?? scene.fog.constructor.name} is unsupported.`);
  if (scene.environment && !scene.environment.isDataTexture) {
    throw new Error(`${locate(scene)}: environment must be an equirectangular HDR DataTexture.`);
  }
  if (scene.background && !scene.background.isColor && !scene.background.isDataTexture) {
    throw new Error(`${locate(scene)}: background must be a Color or an equirectangular HDR DataTexture.`);
  }
  scene.traverseVisible(object => {
    if (object.isPoints || object.isLine || object.isSprite ||
        (object.isLight && !(object.isPointLight || object.isSpotLight || object.isDirectionalLight ||
          object.isRectAreaLight || object.isAmbientLight))) {
      throw new Error(`${locate(object)} is unsupported by MuTracer.`);
    }
  });
  // The adapter emits its three conversion warnings synchronously with the source mesh.
  const warn = console.warn;
  console.warn = (...args) => {
    const [message, object] = args;
    if (message?.isObject3D && typeof object === 'string') {
      const materials = [message.material].flat().filter(Boolean).map(material => material.type).join(', ');
      throw new Error(`${locate(message)}${materials ? ` (${materials})` : ''}: ${object}`);
    }
    if (typeof message === 'string' && message.startsWith('MuTracer:') && object?.isObject3D) {
      throw new Error(`${locate(object)}: ${message}`);
    }
    warn.apply(console, args);
  };
  try {
    return convert();
  } finally {
    console.warn = warn;
  }
}
