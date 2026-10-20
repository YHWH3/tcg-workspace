import { isInlineSafeMime } from '../../shared/filekinds';
import { sanitizeSvg } from '../../shared/svgSanitize';

/**
 * A `blob:` URL inherits the origin of the page that created it, so a stored
 * document type (text/html, xhtml, xml, scripted SVG) opened or iframed from
 * one would run with the app's session. The blob's type comes from whatever
 * was uploaded — or cached before the server enforced its serving policy — so
 * it is re-decided here at the single place object URLs are made: inline-safe
 * types pass, SVG is re-sanitized, everything else becomes an opaque download.
 */
export async function renderableBlob(blob: Blob): Promise<Blob> {
  const type = blob.type.split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') {
    const svg = sanitizeSvg(await blob.text());
    return svg.ok ? new Blob([svg.svg], { type: 'image/svg+xml' }) : new Blob([blob], { type: 'application/octet-stream' });
  }
  return isInlineSafeMime(type) ? blob : new Blob([blob], { type: 'application/octet-stream' });
}
