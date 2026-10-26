/** Runs in the browser realm through page.evaluate(). */
export function canvasBodyPoint(id) {
  const el = document.querySelector(`[data-mooditem="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const candidates = [[0.1,0.1],[0.5,0.1],[0.9,0.1],[0.1,0.5],[0.5,0.5],[0.9,0.5],[0.1,0.9],[0.5,0.9],[0.9,0.9],[0.25,0.25],[0.75,0.75]];
  for (const [fx,fy] of candidates) {
    const x=r.x+r.width*fx,y=r.y+r.height*fy,top=document.elementFromPoint(x,y);
    if (!top || !(top===el || el.contains(top))) continue;
    // Nested buttons/editors stop pointer-down intentionally. A visible child
    // is not necessarily a canvas-body gesture surface (e.g. Comments).
    const control=top.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"],[data-testid="resize-handle"]');
    if (control && el.contains(control)) continue;
    return {x,y};
  }
  return null;
}
