/* "Apply to selection" — writes an assistant rewrite back into the page block
 * the user selected, through the editor history adapter:
 *   commitFields() → mutate() (one local write path: outbox, field
 *   timestamps, server sync and therefore server revision history) + an
 *   editor-local undo entry for `page:<pageId>` whose inverse refuses to
 *   replay over intervening edits (conflicts are preserved as drafts).
 * No MCP tool or server AI endpoint is involved. */
import { db } from '../db';
import { beginEditing, commitFields, undo, type UndoResult } from '../editorHistory';
import { planSelectionReplace } from './applyPlan';
import type { SelectionTarget } from './store';

export type ApplyResult =
  | { status: 'applied'; editorId: string }
  | { status: 'changed' }
  | { status: 'empty' }
  | { status: 'missing_block' };

export async function applyToSelection(target: SelectionTarget, replacement: string): Promise<ApplyResult> {
  // Re-read the block's CURRENT stored text. A pending debounced edit is
  // flushed (mutate called) on editor blur, which precedes this click, and its
  // readwrite transaction is ordered ahead of this read by IndexedDB.
  const row = await db.blocks.get(target.blockId);
  if (!row || row.deleted || String(row.pageId ?? '') !== target.pageId) return { status: 'missing_block' };
  const plan = planSelectionReplace(String(row.text ?? ''), target.text, replacement);
  if (!plan.ok) return plan.reason === 'empty' ? { status: 'empty' } : { status: 'changed' };
  const editorId = beginEditing(`page:${target.pageId}`);
  await commitFields(editorId, 'blocks', target.blockId, { text: plan.next }, { group: `ai-apply:${target.blockId}:${Date.now()}`, label: 'AI rewrite' });
  return { status: 'applied', editorId };
}

/** Undo the most recent entry of that editor history (our apply). */
export function undoApply(editorId: string): Promise<UndoResult> {
  return undo(editorId);
}
