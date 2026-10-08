/**
 * Google Drive / Docs URL classification — re-exports shared/drive.ts
 * (single source, also used by worker/markdown) plus the UI-side one-time
 * note constant.
 */
export { parseLinkUrl, type LinkRef, type GDriveRef, type PlainLinkRef } from '../../shared/drive';
import { parseLinkUrl, type LinkRef } from '../../shared/drive';

export interface DriveEmbed {
  provider: 'gdrive' | 'link';
  embedUrl?: string;
  title: string;
  url: string;
}

/** Classify a pasted URL for rendering. Never null — unknown inputs fall back to a plain link card. */
export function driveEmbed(rawUrl: string): DriveEmbed {
  const ref: LinkRef | null = parseLinkUrl(rawUrl);
  if (!ref) return { provider: 'link', title: String(rawUrl ?? '').trim().slice(0, 80), url: String(rawUrl ?? '') };
  if (ref.provider === 'link') return { provider: 'link', title: ref.title, url: ref.url };
  const type = ref.embedUrl.match(/docs\.google\.com\/(document|spreadsheets|presentation)\//)?.[1];
  const title = type ? (type === 'document' ? 'Google Doc' : type === 'spreadsheets' ? 'Google Sheet' : 'Google Slides') : ref.embedUrl.includes('embeddedfolderview') ? 'Google Drive folder' : 'Google Drive file';
  return { provider: 'gdrive', embedUrl: ref.embedUrl, title, url: ref.url };
}

/** Note shown once per user before the first Drive embed/link is added. */
export const DRIVE_ACCESS_NOTE = 'People need access to the file in Drive to see the preview.';
export const DRIVE_NOTE_KEY = 'ws_drive_access_note_seen';
