import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));
await mkdir(OUT, { recursive: true });

// Monogram mark: rounded dark tile, light "W" chevron.
const svg = (size, pad, radius) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#171717"/>
  <g transform="translate(${pad} ${pad}) scale(${(size - pad * 2) / 512})">
    <path d="M128 160 L192 352 L232 352 L256 240 L280 352 L320 352 L384 160 L336 160 L300 296 L276 192 L236 192 L212 296 L176 160 Z" fill="#ffffff"/>
  </g>
</svg>`;

const jobs = [
  ['icon-192.png', 192, 0, 44],
  ['icon-512.png', 512, 0, 112],
  ['maskable-512.png', 512, 60, 0],
  ['apple-touch-icon.png', 180, 14, 40],
];

for (const [name, size, pad, radius] of jobs) {
  await sharp(Buffer.from(svg(size, pad, radius))).png().toFile(`${OUT}${name}`);
  console.log('wrote', name);
}
