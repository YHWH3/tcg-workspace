import { useEffect, useRef, useState } from 'react';

/**
 * Container-relative layout (platform spec §3): dashboard blocks adapt to
 * their own width, not the viewport — a block in a narrow aside must render
 * compact even on a desktop window. `compact` flips under ~560px of usable
 * inline width so blocks can stack, switch to agenda lists, etc.
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  width: number;
  compact: boolean;
} {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth || 0);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return { ref, width, compact: width > 0 && width < 560 };
}
