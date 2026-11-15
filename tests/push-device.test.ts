import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readPushDevice,writePushDevice} from '../shared/pushDevice';

const handlers=new Map<string,(event:any)=>void>();
const show=vi.fn(),focus=vi.fn(),navigate=vi.fn(),open=vi.fn();
const origin='https://workspace.example.test';
const identity={userId:'fixture-user',session:'fixture-session'};
beforeEach(async()=>{
  handlers.clear();show.mockReset();focus.mockReset();navigate.mockReset();open.mockReset();
  await writePushDevice(identity);
  vi.stubGlobal('self',{
    __WB_MANIFEST:[],location:{origin},
    addEventListener:(name:string,handler:(event:any)=>void)=>handlers.set(name,handler),
    registration:{showNotification:show},
    clients:{matchAll:async()=>[{url:origin+'/home',focus,navigate}],openWindow:open},
  });
  vi.resetModules();
  await import('../src/sw');
});
afterEach(()=>{vi.unstubAllGlobals();});
async function dispatch(name:string,fields:Record<string,unknown>) {
  let done:Promise<unknown>|undefined;
  handlers.get(name)!({...fields,waitUntil:(promise:Promise<unknown>)=>{done=promise;}});
  await done;
}
it('shows only a push for the current device account and session',async()=>{
  const data={...identity,title:'Readable title',tag:'notification-fixture'};
  await dispatch('push',{data:{json:()=>data}});
  expect(show).toHaveBeenCalledWith('Readable title',expect.objectContaining({tag:'notification-fixture',data:{...identity,url:'/inbox'}}));
  await dispatch('push',{data:{json:()=>({...data,session:'old-session'})}});
  await dispatch('push',{data:{json:()=>({...data,userId:'other-user'})}});
  expect(show).toHaveBeenCalledTimes(1);
});
it('fences delayed cleanup and suppresses in-flight notifications after sign-out',async()=>{
  const next={...identity,session:'new-session'};
  await writePushDevice(next);
  expect(await writePushDevice(null,identity.session)).toBe(false);
  expect(await readPushDevice()).toEqual(next);
  expect(await writePushDevice(null,next.session)).toBe(true);
  await dispatch('push',{data:{json:()=>({...next,title:'Old notification'})}});
  expect(show).not.toHaveBeenCalled();
});
it('opens same-origin links for the current account and refuses foreign or stale links',async()=>{
  const close=vi.fn();
  await dispatch('notificationclick',{notification:{close,data:{...identity,url:'/inbox'}}});
  expect(navigate).toHaveBeenCalledWith(origin+'/inbox');
  expect(focus).toHaveBeenCalledTimes(1);
  await dispatch('notificationclick',{notification:{close,data:{...identity,url:'https://evil.example.test/'}}});
  await dispatch('notificationclick',{notification:{close,data:{...identity,session:'old-session',url:'/inbox'}}});
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});
