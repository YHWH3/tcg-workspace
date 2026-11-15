/** Small origin-local identity guard shared by the app and classic service worker. */
export interface PushDevice {userId:string;session:string}
async function openPushDevice() {
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('workspace-push-device',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('device');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function readPushDevice():Promise<PushDevice|null> {
  const db=await openPushDevice();
  try{
    return await new Promise<PushDevice|null>((resolve,reject)=>{
      const transaction=db.transaction('device','readonly');
      const request=transaction.objectStore('device').get('current');
      transaction.oncomplete=()=>resolve(request.result??null);
      transaction.onerror=()=>reject(transaction.error);
    });
  }finally{db.close();}
}
/** Expected session prevents delayed cleanup from clearing a new account. */
export async function writePushDevice(next:PushDevice|null,expectedSession?:string) {
  const db=await openPushDevice();
  try{
    return await new Promise<boolean>((resolve,reject)=>{
      const transaction=db.transaction('device','readwrite'),store=transaction.objectStore('device');
      const request=store.get('current');
      let changed=false;
      request.onsuccess=()=>{
        const current=request.result as PushDevice|undefined;
        if(expectedSession!==undefined&&current?.session!==expectedSession)return;
        changed=true;
        if(next)store.put(next,'current');else store.delete('current');
      };
      transaction.oncomplete=()=>resolve(changed);
      transaction.onabort=()=>reject(transaction.error);
      transaction.onerror=()=>reject(transaction.error);
    });
  }finally{db.close();}
}
