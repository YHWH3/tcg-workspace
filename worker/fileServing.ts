import {sanitizeSvg} from '../shared/svgSanitize';
import {isInlineSafeMime} from '../shared/filekinds';

/** SVG must be served inert: sandboxed, scripts/styles locked down. */
export const SVG_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export function svgHeaders(mime: string | null | undefined): Record<string, string> {
  return mime === 'image/svg+xml' ? { 'Content-Type': 'image/svg+xml', ...SVG_HEADERS } : {};
}

/**
 * The ONLY place a stored file's `Content-Type` is decided. The uploader
 * supplies the MIME string at `complete`, so it is untrusted: serving
 * `text/html` (or xhtml/xml/js) from the application origin would execute an
 * attachment as a page — directly through the unauthenticated share routes, or
 * through a `blob:` URL (which inherits this origin) in the in-app preview.
 * Anything outside the inline-safe allowlist is served as an opaque download.
 */
export function servedFileHeaders(mime: string | null | undefined): Record<string, string> {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') return svgHeaders(type);
  if (isInlineSafeMime(type)) return { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
  return { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' };
}

/**
 * Body + headers for stored bytes. SVG is re-sanitized at serve time: bytes
 * stored by a path that predates sanitization (public form upload, remote
 * import) are never trusted. A document the sanitizer rejects is served as an
 * opaque download. Everything else follows servedFileHeaders.
 */
export function servedFile(mime: string | null | undefined, bytes: Uint8Array<ArrayBuffer>): { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') {
    const svg = sanitizeSvg(new TextDecoder().decode(bytes));
    if (!svg.ok) return { body: bytes, headers: servedFileHeaders('application/octet-stream') };
    const body = new TextEncoder().encode(svg.svg);
    return { body, headers: servedFileHeaders(type) };
  }
  return { body: bytes, headers: servedFileHeaders(type) };
}

