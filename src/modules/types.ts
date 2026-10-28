import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import type { Collection } from '../../shared/collections';

export interface AppModule {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Primary nav entry in sidebar / bottom tab bar. */
  navItem?: { path: string; label: string; icon: LucideIcon; /** false keeps it out of the compact bottom tab bar (still in the sidebar and menu drawer). */ tab?: boolean };
  routes: RouteObject[];
  /** Dexie collections this module owns. */
  collections: Collection[];
  /** Extra sidebar content (e.g. the pages tree). */
  sidebarSection?: ComponentType;
  /** Optional badge rendered on the nav item (e.g. unread dot). */
  navBadge?: ComponentType;
  /** Extension points other modules can plug into. */
  slots?: {
    taskDetail?: ComponentType<{ taskId: string }>;
    pageFooter?: ComponentType<{ pageId: string }>;
    /** Existing board-stage approval request, reused by operational desks. */
    stageApproval?:ComponentType<{taskId:string;boardId:string;stageId:string;onClose:()=>void}>;
    /** Comment badge + thread popover/sheet on a block or mood item. */
    commentBadge?: ComponentType<{ targetType: 'block' | 'mooditem'; targetId: string; overlay?: boolean }>;
  };
}

export type SlotKind = keyof NonNullable<AppModule['slots']>;

export function slotComponents(modules: AppModule[], kind: SlotKind) {
  const out: NonNullable<NonNullable<AppModule['slots']>[SlotKind]>[] = [];
  for (const m of modules) {
    const comp = m.slots?.[kind];
    if (comp) out.push(comp);
  }
  return out;
}
