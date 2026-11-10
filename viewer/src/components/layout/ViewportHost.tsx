import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Viewport } from '../Viewport';

// The viewport renders into one element that moves between layouts (desktop workspace, mobile,
// hidden UI), so switching layouts never remounts it and reloads the scene.
const host = document.createElement('div');
host.className = 'viewport-host';

export function ViewportPortal() {
  return createPortal(<Viewport />, host);
}

export function ViewportSlot() {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current!;
    element.appendChild(host);
    return () => { if (host.parentNode === element) element.removeChild(host); };
  }, []);
  return <div ref={slot} className="viewport-slot" />;
}
