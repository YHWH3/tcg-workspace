import {afterEach,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
// @ts-expect-error JavaScript orchestration helper has no declaration file.
import {waitForApiReads} from '../scripts/navigation-ready.mjs';
class Page extends EventEmitter {frame={};mainFrame(){return this.frame;}}
function request(path:string,method='GET',navigation=false,frame:unknown=null){return {url:()=>`https://127.0.0.1${path}`,method:()=>method,isNavigationRequest:()=>navigation,resourceType:()=>navigation?'document':'fetch',frame:()=>frame};}
afterEach(()=>vi.useRealTimers());
it('retires only old-document reads after an observed main-document navigation',async()=>{
 vi.useFakeTimers();const page=new Page();let done=false;const first=waitForApiReads(page).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(250);await first;
 const old=request('/api/sync/pull','POST'),newRead=request('/api/attention'),write=request('/api/sync/push','POST');page.emit('request',old);page.emit('request',write);page.emit('request',request('/pages/a','GET',true,page.frame));page.emit('request',request('/api/sync/pull','POST'));page.emit('framenavigated',page.frame);page.emit('request',newRead);
 done=false;const waiting=waitForApiReads(page).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(500);expect(done).toBe(false);page.emit('requestfinished',newRead);await vi.advanceTimersByTimeAsync(500);expect(done).toBe(false);page.emit('requestfinished',write);await vi.advanceTimersByTimeAsync(250);await waiting;expect(done).toBe(true);
});
it('keeps stalled current-document reads blocking and does not treat a SPA/subframe navigation as retirement',async()=>{
 vi.useFakeTimers();const page=new Page();const first=waitForApiReads(page);await vi.advanceTimersByTimeAsync(250);await first;
 page.emit('request',request('/api/attention'));page.emit('framenavigated',page.frame);page.emit('request',request('/frame','GET',true,{}));page.emit('framenavigated',{});
 const wait=expect(waitForApiReads(page)).rejects.toThrow('did not settle');await vi.advanceTimersByTimeAsync(20000);await wait;
});
