/** Presentation-only accounting. Audit rows remain part of the frozen plan. */
export interface ImpactCounts { create:number; update:number; delete:number }
export interface PreviewImpact extends ImpactCounts {
 content?:ImpactCounts;
 audit?:ImpactCounts;
}
export function partitionPreviewImpact(
 ops:readonly {id:string;collection:string;patch:Record<string,unknown>}[],
 exists:(id:string)=>boolean,
):{content:ImpactCounts;audit:ImpactCounts} {
 const count=(rows:typeof ops):ImpactCounts=>({
  create:rows.filter(o=>!exists(o.id)).length,
  update:rows.filter(o=>exists(o.id)&&!o.patch.deleted).length,
  delete:rows.filter(o=>o.patch.deleted===true).length,
 });
 return {content:count(ops.filter(o=>o.collection!=='activity')),audit:count(ops.filter(o=>o.collection==='activity'))};
}
const counts=(c:ImpactCounts)=>`${c.create} create · ${c.update} update · ${c.delete} delete`;
/** Old persisted previews lack the split: label their total explicitly. */
export function previewImpactText(impact:PreviewImpact):string[] {
 return [
  ...(impact.content&&impact.audit?[`Content items: ${counts(impact.content)}`,`Activity/audit rows: ${counts(impact.audit)}`]:[]),
  `Total planned operations: ${counts(impact)}${impact.content?'':' (includes content and activity/audit rows)'}`,
 ];
}
