import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {clearDevicePush,enableDevicePush,pushSession} from '../src/core/push';
import {readPushDevice,writePushDevice} from '../shared/pushDevice';

const publicKey='BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const values=new Map<string,string>();
const unsubscribe=vi.fn(),subscribe=vi.fn();
const request=vi.fn<typeof fetch>();
let subscription:PushSubscription|null;
beforeEach(async()=>{
  values.clear();unsubscribe.mockReset();subscribe.mockReset();request.mockReset();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null});
  vi.stubGlobal('Notification',{requestPermission:async()=> 'granted'});
  vi.stubGlobal('fetch',request);
  const old={endpoint:'https://fcm.googleapis.com/old-account',unsubscribe,toJSON:()=>({endpoint:'https://fcm.googleapis.com/old-account'})} as unknown as PushSubscription;
  subscription=old;
  unsubscribe.mockImplementation(async()=>{subscription=null;return true;});
  subscribe.mockImplementation(async()=>subscription={
    endpoint:'https://fcm.googleapis.com/new-account',unsubscribe,
    toJSON:()=>({endpoint:'https://fcm.googleapis.com/new-account'}),
  } as unknown as PushSubscription);
  vi.stubGlobal('navigator',{serviceWorker:{getRegistration:async()=>({
    getNotifications:async()=>[],
    pushManager:{getSubscription:async()=>subscription,subscribe},
  })}});
  request.mockImplementation(async(_url,options)=>{
    const body=JSON.parse(String(options?.body));
    const headers=options?.headers as Record<string,string>;
    const wrongOwner=options?.method==='POST'&&body.endpoint===old.endpoint&&headers.Authorization!=='Bearer old-session';
    return Response.json(wrongOwner?{error:'This device belongs to another session.'}:{ok:true},{status:wrongOwner?409:200});
  });
  values.set('ws_token','old-session');values.set('ws_uid','old-user');
  await writePushDevice({userId:'old-user',session:await pushSession('old-session')});
});
afterEach(async()=>{await writePushDevice(null);vi.unstubAllGlobals();});

it('recovers an old-account subscription after interrupted sign-out cleanup',async()=>{
  unsubscribe.mockRejectedValueOnce(new Error('simulated offline unsubscribe'));
  await expect(clearDevicePush('old-session')).rejects.toThrow('simulated offline unsubscribe');
  expect(await readPushDevice()).toBeNull();
  values.set('ws_token','new-session');values.set('ws_uid','new-user');
  await expect(enableDevicePush(publicKey)).resolves.toBeUndefined();
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(await readPushDevice()).toEqual({userId:'new-user',session:await pushSession('new-session')});
});

it('reuses the active session subscription without rotating it',async()=>{
  await enableDevicePush(publicKey);
  expect(subscribe).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(await readPushDevice()).toEqual({userId:'old-user',session:await pushSession('old-session')});
});
