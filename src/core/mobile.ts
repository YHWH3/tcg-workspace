import { useEffect, useState } from 'react';

/** True below the sm breakpoint (767px). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = matchMedia('(max-width: 767px)');
    const fn = () => setMobile(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return mobile;
}
