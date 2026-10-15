export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';
export type ParentType = 'task' | 'block' | 'mooditem' | 'form-pending';

export function kindOf(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

/**
 * MIME types safe to render inline (a browser cannot be made to run script from
 * the page's origin by them): raster images, audio, video and PDF. Everything
 * else — notably text/html, xhtml, xml and script types — must only ever be an
 * opaque download. Shared by the server's response policy and the client's
 * object-URL creation so the two cannot drift.
 */
export const INLINE_SAFE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|heic|heif|tiff)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/;

export function isInlineSafeMime(mime: string | null | undefined): boolean {
  return INLINE_SAFE_MIME.test(String(mime ?? '').split(';')[0].trim().toLowerCase());
}
