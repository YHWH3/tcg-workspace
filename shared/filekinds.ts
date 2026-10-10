export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';
export type ParentType = 'task' | 'block' | 'mooditem' | 'form-pending';

export function kindOf(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}
