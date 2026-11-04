import {it,expect} from 'vitest';
import raw from '../templates/tcg-pack.json';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf} from '../shared/templates';
const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
it('adds recent and self-meeting blocks without replacing existing Meeting views or layout',()=>{
 expect(pack.version).toBeGreaterThanOrEqual(10);expect(pack.snapshot.blocks!.meetings_commitment_review).toMatchObject({type:'commitments',databaseId:'db_meetings',days:30,limit:10});expect(pack.snapshot.blocks!.meeting_linked_commitments).toMatchObject({type:'commitments',databaseId:'db_meetings',meetingId:'self',limit:1});expect(pack.snapshot.blocks!.tpl_4f.type).toBe('view');expect(pack.snapshot.blocks!.tpl_4h.type).toBe('view');expect(pack.snapshot.blocks!.meeting_commitment_scope_note.text).toContain('other meetings');
});
it('copies live commitment configuration without copying unrelated databases',()=>{
 const block=pack.snapshot.blocks!.meeting_linked_commitments;expect(boardRefsOf(block)).toEqual([]);const plan=planTemplateInstantiation({...pack.snapshot,blocks:{meeting_linked_commitments:block}},{templateId:'pg_tpl_meeting'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(plan.writes.filter(write=>['boards','tasks'].includes(write.collection))).toEqual([]);expect(plan.writes.find(write=>write.patch.type==='commitments')?.patch).toMatchObject({databaseId:'db_meetings',meetingId:'self',limit:1});
});
it('preserves edited headings, selected meetings and deleted reservations on additive upgrade',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!,rows=plan.writes.map(write=>({id:write.id,collection:write.collection,data:{...write.patch}}));
 const recent=rows.find(row=>row.data.templateItemKey==='meetings_commitment_review')!,self=rows.find(row=>row.data.templateItemKey==='meeting_linked_commitments')!;recent.data.heading='Our commitments';recent.data.meetingId='chosen-meeting';self.data.deleted=true;rows.find(row=>row.data.templateKey==='tcg-pack')!.data.templateVersion=9;
 expect(planPackUpgrade(pack,rows).writes.some(write=>write.id===recent.id||write.id===self.id)).toBe(false);
});
