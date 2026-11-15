import {useEffect,useState} from 'react';
import {Button} from './ui';
import {clearDevicePush,enableDevicePush,pushSession} from './push';
import {getToken} from './api';
import {readPushDevice} from '../../shared/pushDevice';
import {authStore} from './auth';

export interface PushConfig {available:boolean;publicKey:string|null}
export function PushSettings({config}:{config:PushConfig|undefined}) {
  const [enabled,setEnabled]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [permission,setPermission]=useState(typeof Notification==='undefined'?'default':Notification.permission);
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const standalone=matchMedia('(display-mode: standalone)').matches||(navigator as {standalone?:boolean}).standalone===true;
  const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
  useEffect(()=>{
    let active=true;
    const token=getToken();
    if(supported&&token)void Promise.all([readPushDevice(),pushSession(token)]).then(([device,session])=>{
      if(active)setEnabled(device?.userId===authStore.get().user?.id&&device?.session===session);
    },()=>{if(active)setError('Device notification settings could not be read. Try again.');});
    return ()=>{active=false;};
  },[supported]);
  let explanation:string|undefined;
  if(ios&&!standalone)explanation='Open this page in Safari, tap Share, then Add to Home Screen. Open the installed app to enable notifications.';
  else if(!supported)explanation='This browser does not support device notifications.';
  else if(!config?.available)explanation='Device notifications are currently unavailable.';
  else if(permission==='denied')explanation='Notifications are blocked. Allow them in your browser or device settings, then reload.';
  return <fieldset className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
    <legend className="text-sm font-medium">Notifications on this device</legend>
    {explanation?<p className="text-sm text-neutral-600 dark:text-neutral-400">{explanation}</p>:<Button
      disabled={busy||!config?.publicKey} onClick={async()=>{
        setBusy(true);setError('');
        try{
          if(enabled)await clearDevicePush();else await enableDevicePush(config!.publicKey!);
          setEnabled(!enabled);
          setPermission(Notification.permission);
        }catch{
          setPermission(Notification.permission);
          setError('Device notifications could not be updated. Check the permission and connection, then try again.');
        }finally{setBusy(false);}
      }}>{busy?'Updating…':enabled?'Turn off on this device':'Enable on this device'}</Button>}
    {!explanation&&<p className="text-sm" role="status">{enabled?'Enabled on this device.':'Off on this device.'}</p>}
    {error&&<p className="text-sm" role="alert">{error}</p>}
  </fieldset>;
}
