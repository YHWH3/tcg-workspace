import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { uuid } from '../../core/utils';

export interface MoodItem extends LocalRow {
  boardId?: string;
  type?: 'image' | 'note' | 'text' | 'color';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  fileId?: string;
  text?: string;
  color?: string;
  taskId?: string;
}

export const NOTE_COLORS = ['#fef3c7', '#fce7f3', '#dbeafe', '#dcfce7', '#ede9fe'];

export function useMoodboards(): LocalRow[] {
  return (useLiveQuery(() => db.moodboards.filter((b) => !b.deleted).sortBy('order'), [], []) ?? []) as LocalRow[];
}

export function useMoodItems(boardId: string | undefined): MoodItem[] {
  return (
    useLiveQuery(
      () =>
        boardId
          ? db.mooditems
              .where('boardId')
              .equals(boardId)
              .filter((i) => !i.deleted)
              .toArray()
          : Promise.resolve([] as MoodItem[]),
      [boardId],
      [],
    ) ?? []
  ) as MoodItem[];
}

export async function createMoodboard(title = 'Untitled board'): Promise<string> {
  const id = uuid();
  const user = (await import('../../core/auth')).authStore.get().user;
  await mutate('moodboards', id, {
    title,
    icon: '🎨',
    order: String(Date.now()),
    createdBy: user?.id,
    createdAt: Date.now(),
  });
  return id;
}

export async function addMoodItem(boardId: string, patch: Partial<MoodItem>): Promise<string> {
  const id = uuid();
  const items = await db.mooditems.where('boardId').equals(boardId).toArray();
  const z = Math.max(0, ...items.map((i) => Number(i.z ?? 0))) + 1;
  await mutate('mooditems', id, { boardId, z, ...patch });
  return id;
}
