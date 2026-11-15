import { useEffect, useState } from 'react';

/** Matches the stylesheet's mobile breakpoint. */
export const MOBILE_QUERY = '(max-width: 768px), (max-width: 1024px) and (max-height: 500px) and (orientation: landscape) and (pointer: coarse)';

export function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
