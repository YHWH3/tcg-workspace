import 'fake-indexeddb/auto';
import {it,expect,vi} from 'vitest';
vi.mock('../src/core/sync/engine',()=>({mutate:vi.fn()}));
import {viewCtx} from '../src/core/records';
const fields=[{id:'f_experiments',name:'Experiments',type:'relation',relation:{target:'experiments',primary:false,pairedFieldId:'f_media'}},{id:'f_project',name:'Project',type:'relation',relation:{target:'projects',primary:true}}];
it('resolves canonical reverse sources only in the declared target database and ignores unavailable peers',()=>{
 const tasks=[{id:'experiment',boardId:'experiments',title:'Experiment'},{id:'course',boardId:'courses',title:'Course'},{id:'deleted',boardId:'experiments',deleted:true},{id:'archived',boardId:'experiments',archived:true},{id:'project',boardId:'projects',title:'Project'}];
 const links=[...['experiment','course','deleted','archived','missing'].map(id=>({id,kind:'relation',fieldId:'f_media',fromId:id,toId:'media'})),{id:'project-link',kind:'relation',fieldId:'f_project',fromId:'media',toId:'project'}];
 const context=viewCtx({id:'media-db',fields} as never,tasks as never,links as never,'alice','2026-10-31');
 expect(context.relationTitles!('media','f_experiments')).toEqual(['Experiment']);expect(context.relationTitles!('media','f_project')).toEqual(['Project']);expect(context.relationTitles!('media','unknown')).toEqual([]);
});
