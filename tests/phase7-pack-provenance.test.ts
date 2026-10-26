import {expect,it} from 'vitest';
import {toBundled,type AuthorTemplate} from '../shared/bundled';
import {installRecordId,planTemplateInstantiation} from '../shared/templates';
import raw from '../templates/tcg-pack.json';
import legacy from './fixtures/tcg-pack-v1-ids.json';
it('keeps every pre-key authored id and its stable installed id',()=>{
 const bundle=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
 const plan=planTemplateInstantiation(bundle.snapshot,{templateId:bundle.root,templateKey:bundle.key,stableIds:true,packInstall:true},{id:()=>{throw new Error('random id');},now:1})!;
 for(const c of ['boards','pages','views','blocks'] as const){
  for(const id of legacy[c]){
   expect(bundle.snapshot[c],`${c}:${id}`).toHaveProperty(id);
   expect(plan.writes.some(w=>w.collection===c&&w.id===installRecordId(bundle.key,c,id)),`installed ${c}:${id}`).toBe(true);
  }
 }
 expect(bundle.version).toBeGreaterThanOrEqual(2);
 expect(plan.writes.find(w=>w.id===plan.rootPageId)?.patch.templateVersion).toBe(bundle.version);
});
