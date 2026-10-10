/* Google Drive / Docs URL classification (Phase 1 §4.7): turns a pasted URL
 * into an embed target the client can iframe, or a plain link card.
 * Large media stays in Drive — the app stores links + previews, never bytes. */

export interface GDriveRef {
  provider: 'gdrive';
  /** Original URL as pasted. */
  url: string;
  /** Iframe-safe preview URL (Drive `/preview`, Docs `/preview`, folder grid). */
  embedUrl: string;
  /** Drive file / Docs document / folder id. */
  fileId: string;
}

export interface PlainLinkRef {
  provider: 'link';
  url: string;
  /** Display title: hostname + path (no fetch). */
  title: string;
}

export type LinkRef = GDriveRef | PlainLinkRef;

const FILE_ID = String.raw`([\w-]+)`;

/** `https://drive.google.com/file/d/<id>/…` (+ /view, ?usp=… suffixes). */
const FILE_RE = new RegExp(`^/file/d/${FILE_ID}(?:[/?#]|$)`);
/** `https://drive.google.com/drive/folders/<id>` or `/drive/u/<n>/folders/<id>`. */
const FOLDER_RE = new RegExp(`^/drive/(?:u/\\d+/)?folders/${FILE_ID}(?:[/?#]|$)`);
/** `https://docs.google.com/<document|spreadsheets|presentation>/d/<id>/…`. */
const DOCS_RE = new RegExp(`^/(document|spreadsheets|presentation)/d/${FILE_ID}(?:[/?#]|$)`);

function isHost(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname === `www.${host}`;
}

/**
 * Classify a URL. Returns a `gdrive` ref with embed target for Drive/Docs
 * patterns, a `link` ref for any other valid http(s) URL, or `null` when the
 * input is not a parseable absolute URL.
 */
export function parseLinkUrl(raw: string): LinkRef | null {
  const text = String(raw ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  if (isHost(url, 'drive.google.com')) {
    const file = FILE_RE.exec(url.pathname);
    if (file) {
      const fileId = file[1];
      return { provider: 'gdrive', url: text, embedUrl: `https://drive.google.com/file/d/${fileId}/preview`, fileId };
    }
    const folder = FOLDER_RE.exec(url.pathname);
    if (folder) {
      const fileId = folder[1];
      return { provider: 'gdrive', url: text, embedUrl: `https://drive.google.com/embeddedfolderview?id=${fileId}#grid`, fileId };
    }
    // /open?id=<fileId> (and any other path that carries a bare ?id= file param)
    const openId = url.searchParams.get('id');
    if (openId && /^[\w-]+$/.test(openId)) {
      return { provider: 'gdrive', url: text, embedUrl: `https://drive.google.com/file/d/${openId}/preview`, fileId: openId };
    }
  }

  if (isHost(url, 'docs.google.com')) {
    const doc = DOCS_RE.exec(url.pathname);
    if (doc) {
      const [, type, fileId] = doc;
      return { provider: 'gdrive', url: text, embedUrl: `https://docs.google.com/${type}/d/${fileId}/preview`, fileId };
    }
  }

  const title = url.hostname + (url.pathname === '/' ? '' : url.pathname);
  return { provider: 'link', url: text, title };
}
