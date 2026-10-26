import {expect,it} from 'vitest';
import {rebaseRecord} from '../src/core/sync/rebase';
const fields=[{id:'amount',name:'Amount',type:'number'}],upgraded=[{...fields[0],format:'currency'}];
it('retains the reviewed optimistic upgrade only while its field source matches',()=>{
 const pending={id:'b',patch:{fields:upgraded},ts:20,ifUnchanged:{fields:{fields}}};
 expect(rebaseRecord({data:{fields},field_ts:{fields:10}},[pending]).data.fields).toEqual(upgraded);
 const human=[{...fields[0],currency:'USD',format:'currency'}];
 expect(rebaseRecord({data:{fields:human},field_ts:{fields:15}},[pending]).data.fields).toEqual(human);
 expect(rebaseRecord({data:{fields},field_ts:{fields:10}},[{...pending,state:'rejected'}]).data.fields).toEqual(fields);
});
it('keeps unconfirmed guarded creations and never paints over a reserved server identity',()=>{
 const pending={id:'new',patch:{title:'New page'},ts:20,ifUnchanged:{absent:true as const}};
 expect(rebaseRecord({data:{},field_ts:{}},[pending],false).data.title).toBe('New page');
 expect(rebaseRecord({data:{title:'Reserved',deleted:true},field_ts:{title:10,deleted:10}},[pending]).data).toEqual({title:'Reserved',deleted:true});
});
