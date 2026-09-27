import type { ComponentType } from 'react';
import type { LocalRow } from '../../../core/db';

/**
 * Block renderer registry: maps a block `type` to a component.
 * Modules self-register (pages registers media blocks, boards registers the
 * embedded task list) so adding a block type never touches the editor core —
 * and Phase B's contentEditable swap only touches the text-input path.
 */
export interface MediaBlockProps {
  block: LocalRow;
  onNewBelow: () => void;
  onDelete: () => void;
}

export interface InsertEntry {
  type: string;
  label: string;
}

const renderers = new Map<string, ComponentType<MediaBlockProps>>();
const entries: InsertEntry[] = [];

export function registerBlockType(type: string, label: string, renderer: ComponentType<MediaBlockProps>): void {
  renderers.set(type, renderer);
  if (!entries.some((e) => e.type === type)) entries.push({ type, label });
}

export function blockRenderer(type: string | undefined): ComponentType<MediaBlockProps> | undefined {
  return type ? renderers.get(type) : undefined;
}

export function insertEntries(): InsertEntry[] {
  return entries;
}
