/** Preserve the configured avatar hue; choose the more legible neutral ink.
 * Account colours use the hex palette in config.ts (legacy values may be #rgb).
 */
export function avatarTextColor(background: string): '#000' | '#fff' {
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(background);
  const hex = short ? short.slice(1).map(c => c + c).join('') : background.replace(/^#/, '');
  if (!/^[a-f\d]{6}$/i.test(hex)) return '#fff';
  const channels = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000' : '#fff';
}
