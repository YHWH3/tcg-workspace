import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import type {readReliability} from '../src/core/reliabilityData';

const fixture=vi.hoisted(()=>({query:undefined as undefined|(()=>Promise<{data:Awaited<ReturnType<typeof readReliability>>|null}>),store:undefined as unknown,now:1000000}));
vi.mock('react',()=>({useState:()=>[fixture.now,vi.fn()],useEffect:vi.fn()}));
vi.mock('dexie-react-hooks',()=>({useLiveQuery:(query:()=>Promise<{data:Awaited<ReturnType<typeof readReliability>>|null}>)=>{fixture.query=query;}}));
vi.mock('../src/core/db',async importOriginal=>({...await importOriginal<typeof import('../src/core/db')>(),get db(){return fixture.store;}}));
vi.mock('../src/core/auth',()=>({authStore:{get:()=>({user:{id:'clock'}})}}));
vi.mock('../src/core/api',()=>({getToken:()=> 'disposable-session'}));
vi.mock('../src/core/accessClient',()=>({accessClientStore:{get:()=>({manifest:{},epoch:1,status:'ready'})}}));
vi.mock('../src/core/live',()=>({liveStore:{get:()=>({connected:true})}}));
vi.mock('../src/core/uploadState',()=>({uploadActivity:{get:()=>({userId:'clock',ids:[]})}}));
vi.mock('../src/core/store',()=>({useStore:(store:{get:()=>unknown})=>store.get()}));
import {useReliability} from '../src/core/reliability';
let db:LocalDB;
afterEach(async()=>{vi.useRealTimers();vi.unstubAllGlobals();if(db){db.close();await db.delete();}});
it('uses observation time when Dexie reruns after a fresh edit between periodic ticks',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(fixture.now);vi.stubGlobal('navigator',{onLine:true});
 db=new LocalDB('workspace-clock');fixture.store=db;await db.open();useReliability();
 expect((await fixture.query!()).data).toMatchObject({pending:0,attention:false});
 vi.setSystemTime(fixture.now+1000);
 await db.outbox.add({id:'fresh',collection:'pages',patch:{title:'Synthetic fresh edit'},ts:Date.now(),enqueuedAt:Date.now()});
 // LiveQuery reruns from the write; React's periodic state is still the mount time.
 expect((await fixture.query!()).data).toMatchObject({asOf:fixture.now+1000,pending:1,oldestAgeMs:0,unknownPendingAge:false,attention:false});
 vi.setSystemTime(fixture.now+122000);
 expect((await fixture.query!()).data).toMatchObject({pending:1,oldestAgeMs:121000,attention:true});
});
