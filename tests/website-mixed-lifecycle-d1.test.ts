import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {website,send,consultingEvent,type Fixture} from './website-fixture';
import {applyChanges} from '../worker/sync';
import {WEBSITE_PEOPLE_BOARD,WEBSITE_PEOPLE_ID} from '../shared/websiteInbox';
let f:Fixture;afterEach(async()=>{await f?.mf.dispose();});
it('matches 400 existing People, creates 550 and skips 50 unusable identities with permissions enabled',async()=>{
 f=await website('website-mixed-permissions');
 await applyChanges(f.env,'alice',[{id:WEBSITE_PEOPLE_ID,collection:'boards',patch:{...WEBSITE_PEOPLE_BOARD},ts:0}],{serverTs:true});
 const seeded=await applyChanges(f.env,'alice',Array.from({length:450},(_,i)=>({id:'mixed_person_'+i,collection:'tasks',patch:{boardId:WEBSITE_PEOPLE_ID,title:'Fixture '+i,p_wp_email:`seed${i}@example.org`,status:'all',...(i>=400?i%2?{deleted:true}:{archived:true}:{})},ts:0})),{serverTs:true});
 expect(seeded.rejected).toBeFalsy();await f.db.prepare('UPDATE access_state SET enabled=1').run();
 const counts={matched:0,created:0,unusable_identity:0};
 for(let i=0;i<1000;i++){
  const email=i<400?`seed${i}@example.org`:i<950?`new${i}@example.org`:`seed${i-550}@example.org`;
  const result=await send(f,consultingEvent('mixed_'+i,{reply_to:email}));
  expect(result.status,JSON.stringify({index:i,...result.body})).toBe(200);
  const kind=result.body.matchingStatus as keyof typeof counts;expect(kind in counts).toBe(true);counts[kind]++;
  if(i>=950)expect(result.body.personId).toBeUndefined();
 }
 expect(counts).toEqual({matched:400,created:550,unusable_identity:50});expect(f.maxBudgetUsed).toBeLessThanOrEqual(45);
 const active=await f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.archived'),0)=0").bind(WEBSITE_PEOPLE_ID).first<number>('n');expect(active).toBe(950);
 const broken=await f.db.prepare("SELECT COUNT(*) n FROM records l JOIN records p ON p.id=json_extract(l.data,'$.toId') WHERE l.collection='links' AND (json_extract(p.data,'$.deleted')=1 OR json_extract(p.data,'$.archived')=1)").first<number>('n');expect(broken).toBe(0);
},600000);
