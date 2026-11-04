import {it,expect} from 'vitest';
import raw from '../templates/tcg-pack.json';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf,installRecordId} from '../shared/templates';
import {applyView,type ViewConfig} from '../shared/views';
const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
it('adds an Editorial child desk with explicit personal Media approvals and source association limits',()=>{
 expect(pack.version).toBeGreaterThanOrEqual(8);expect(pack.snapshot.pages.pg_editorial).toMatchObject({parentId:'pg_media',title:'Editorial desk'});
 expect(pack.snapshot.blocks!.editorial_approvals).toMatchObject({type:'attention',approvalDatabaseId:'db_media',kinds:['approval_pending']});
 const page=raw.pages.find(page=>page.id==='pg_editorial')!;expect(JSON.stringify(page)).toContain('review those sections separately');expect(JSON.stringify(page)).toContain('do not assess evidence quality');
 expect(pack.snapshot.blocks!.editorial_calendar).toMatchObject({sources:[{databaseId:'db_media',dateKey:'p_f_publish_date'}]});
});
it('keeps owner and date gaps independent, excludes archived stage and selects only review work',()=>{
 const rows=[{id:'owner',status:'review',p_f_publish_date:'2026-11-02'},{id:'date',status:'editing',p_f_owner:'alice'},{id:'both',status:'research'},{id:'archived',status:'archived'}];
 const ids=(key:string)=>applyView(rows,pack.snapshot.views![key].config as ViewConfig).rows.map(row=>row.id);
 expect(ids('v_media_missing_owner')).toEqual(['owner','both']);expect(ids('v_media_missing_date')).toEqual(['date','both']);expect(ids('v_media_review')).toEqual(['owner']);
 expect(pack.snapshot.views!.v_media_evidence_gaps.config).toMatchObject({filters:expect.arrayContaining([{key:'rel_f_experiments',op:'empty'}])});expect(pack.snapshot.views!.v_fieldlog_unlinked_experiments.config).toMatchObject({filters:[{key:'rel_f_experiment',op:'empty'}]});
});
it('remaps approval scope during a full install and keeps a live reference when copying only its page',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const block=plan.writes.find(write=>write.patch.templateItemKey==='editorial_approvals')!;expect(block.patch.approvalDatabaseId).toBe(installRecordId(pack.key,'boards','db_media'));
 const source=pack.snapshot.blocks!.editorial_approvals;expect(boardRefsOf(source)).toEqual([]);
 const copy=planTemplateInstantiation({...pack.snapshot,blocks:{editorial_approvals:source}},{templateId:'pg_editorial'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(copy.writes.filter(write=>write.collection==='boards'||write.collection==='tasks')).toEqual([]);expect(copy.writes.find(write=>write.patch.type==='attention')?.patch.approvalDatabaseId).toBe('db_media');
});
it('upgrades v7 additively without replacing Media defaults, edited views, blocks or deleted reservations',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const newKeys=new Set(['pg_editorial',...raw.pages.find(page=>page.id==='pg_editorial')!.blocks.map(block=>typeof block==='object'?block.key:''),...['v_media_editorial_pipeline','v_media_review','v_media_missing_owner','v_media_missing_date','v_media_evidence_gaps','v_fieldlog_unlinked_experiments']]);
 const rows=plan.writes.filter(write=>!newKeys.has(String(write.patch.templateItemKey))).map(write=>({id:write.id,collection:write.collection,data:{...write.patch}}));
 rows.find(row=>row.data.templateKey==='tcg-pack')!.data.templateVersion=7;
 const media=rows.find(row=>row.data.templateDbKey==='media')!;media.data.name='Team Media';media.data.defaultViewId='team-view';
 const view=rows.find(row=>row.data.templateItemKey==='v_media_table')!;view.data.config={filters:[{key:'title',op:'contains',value:'Team filter'}]};
 const deleted={id:installRecordId(pack.key,'blocks','editorial_missing_owner'),collection:'blocks' as const,data:{deleted:true,templateItemKey:'editorial_missing_owner'}};rows.push(deleted);
 const upgrade=planPackUpgrade(pack,rows);expect(upgrade.writes.some(write=>write.id===media.id||write.id===view.id||write.id===deleted.id)).toBe(false);
 expect(upgrade.writes.find(write=>write.id===installRecordId(pack.key,'pages','pg_editorial'))?.patch.parentId).toBe(installRecordId(pack.key,'pages','pg_media'));
 expect(upgrade.writes.find(write=>write.patch.templateItemKey==='editorial_approvals')?.patch.approvalDatabaseId).toBe(media.id);
});
