import 'fake-indexeddb/auto';
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/auth',()=>({authStore:{get:()=>({user:{id:'alice'}})},getToken:()=>null,api:vi.fn(()=>Promise.reject(new Error('offline')))}));
import {db} from '../src/core/db';
import {mutate} from '../src/core/sync/engine';
import {deleteBoard} from '../src/modules/boards/api';
beforeEach(async()=>{vi.stubGlobal("localStorage",{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});await db.open();for(const table of db.tables)await table.clear();});
it('INT-02 deleting People retains record identities, relations, body and offline outbox',async()=>{
 await mutate('boards','people',{kind:'records',name:'People',fields:[{id:'email',type:'text'}]});
 await mutate('tasks','person',{boardId:'people',title:'Ada',p_email:'ada@example.invalid',parentId:'parent'});
 await mutate('links','relation',{fromId:'person',toId:'org',kind:'relation'});await mutate('blocks','body',{pageId:'person',text:'Biography'});
 await deleteBoard((await db.boards.get('people'))!);
 expect((await db.tasks.get('person'))!.boardId).toBe('people');
 expect((await db.boards.get('people'))!.archived).toBe(true);
 expect((await db.boards.get('people'))!.deleted).not.toBe(true);
 await mutate('boards','people',{archived:false});
 expect((await db.tasks.get('person'))!.p_email).toBe('ada@example.invalid');expect((await db.links.get('relation'))!.fromId).toBe('person');expect((await db.blocks.get('body'))!.text).toBe('Biography');
 expect((await db.outbox.toArray()).some(r=>r.id==='people'&&r.patch.archived===true)).toBe(true);
});
it('INT-02 original task-board deletion still moves tasks to default',async()=>{
 await mutate('boards','work',{kind:'tasks',name:'Work'});await mutate('tasks','task',{boardId:'work',title:'Task'});
 await deleteBoard((await db.boards.get('work'))!);expect((await db.tasks.get('task'))!.boardId).toBe('board-default');expect((await db.boards.get('work'))!.deleted).toBe(true);
});
it('INT-02 archive/restore leaves all organization data and newly concurrent records in place after reopen',async()=>{
 await mutate('boards','orgs',{kind:'records',name:'Organizations'});await mutate('tasks','org',{boardId:'orgs',title:'Org',p_custom:'Keep'});
 await mutate('views','view',{databaseId:'orgs',type:'table'});await mutate('files','file',{parentId:'org'});await mutate('tasks','child',{boardId:'orgs',parentId:'org'});
 await deleteBoard((await db.boards.get('orgs'))!);await mutate('tasks','concurrent',{boardId:'orgs',title:'Concurrent'});
 db.close();await db.open();await mutate('boards','orgs',{archived:false});
 expect((await db.tasks.get('org'))!.p_custom).toBe('Keep');expect((await db.tasks.get('child'))!.parentId).toBe('org');expect((await db.tasks.get('concurrent'))!.boardId).toBe('orgs');expect((await db.views.get('view'))!.databaseId).toBe('orgs');expect((await db.files.get('file'))!.parentId).toBe('org');
});
