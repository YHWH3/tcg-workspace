/** Record detail route inside the database shell (keeps the active view). */
export function recordHref(boardId: string, viewId: string | undefined, recordId: string): string {
  return viewId ? `/boards/${boardId}/views/${viewId}/records/${recordId}` : `/boards/${boardId}/tasks/${recordId}`;
}

