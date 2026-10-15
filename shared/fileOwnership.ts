/** Thumbnails use `<main-file-id>t` and the main files row's thumbId. An
 * arbitrary record pointing at another thumbnail cannot grant access to it. */
export function thumbnailParentId(id: string): string | null {
  return /^[A-Za-z0-9_-]{2,64}$/.test(id) && id.endsWith('t') ? id.slice(0, -1) : null;
}
export function ownsThumbnail(fileId: string, thumbId: unknown): thumbId is string {
  return typeof thumbId === 'string' && thumbnailParentId(thumbId) === fileId;
}
