import type { CSSProperties } from 'react';

/** Keep the chosen field hue, with readable text on its subtle tinted surface. */
export function fieldOptionStyle(color: string): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
    color: `light-dark(color-mix(in srgb, ${color} 40%, black), color-mix(in srgb, ${color} 40%, white))`,
  };
}
