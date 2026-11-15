/** RFC 8291 encryption and RFC 8292 authentication, using Worker WebCrypto. */
export interface PushEnv {
  WEB_PUSH?: 'off' | 'on' | 'simulated';
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  WORKSPACE_ENV?: string;
  PUSH_TEST_SINK?: Pick<Fetcher,'fetch'>;
}

export const pushBase64 = (bytes:Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
export const pushBytes = (value:string) => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), char=>char.charCodeAt(0));
const text = new TextEncoder();
const join = (...parts:Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size,part)=>size+part.length,0));
  let offset = 0;
  for (const part of parts) {result.set(part,offset);offset+=part.length;}
  return result;
};

export function isPushEndpoint(endpoint:string) {
  const url = URL.parse(endpoint);
  return !!url && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(url.hostname)
      || /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/.test(url.hostname));
}

export function pushMode(env:PushEnv) {
  if (env.WEB_PUSH === 'simulated') return env.WORKSPACE_ENV === 'local-test' && env.PUSH_TEST_SINK ? 'simulated' : null;
  return env.WEB_PUSH === 'on' && /^[\w-]{87}$/.test(env.VAPID_PUBLIC_KEY ?? '')
    && /^[\w-]{43}$/.test(env.VAPID_PRIVATE_KEY ?? '') && /^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT ?? '') ? 'on' : null;
}

async function hkdf(input:Uint8Array<ArrayBuffer>,salt:Uint8Array<ArrayBuffer>,info:Uint8Array<ArrayBuffer>,length:number) {
  const key = await crypto.subtle.importKey('raw',input,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}

export async function encryptPush(p256dh:string,auth:string,payload:Uint8Array<ArrayBuffer>,
  material?:{keyPair:CryptoKeyPair;salt:Uint8Array<ArrayBuffer>}) {
  if (payload.length > 3993) throw new Error('push_payload_too_large');
  const receiver = pushBytes(p256dh);
  const secret = pushBytes(auth);
  if (receiver.length !== 65 || receiver[0] !== 4 || secret.length !== 16) throw new Error('invalid_push_keys');
  const publicKey = await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const sender = material?.keyPair ?? await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw',sender.publicKey));
  const salt = material?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},sender.privateKey,256));
  const ikm = await hkdf(shared,secret,join(text.encode('WebPush: info\0'),receiver,senderPublic),32);
  const keyBytes = await hkdf(ikm,salt,text.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce = await hkdf(ikm,salt,text.encode('Content-Encoding: nonce\0'),12);
  const key = await crypto.subtle.importKey('raw',keyBytes,'AES-GCM',false,['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,join(payload,new Uint8Array([2]))));
  const header = new Uint8Array(86);
  header.set(salt);
  new DataView(header.buffer).setUint32(16,4096);
  header[20] = senderPublic.length;
  header.set(senderPublic,21);
  return join(header,encrypted);
}

export async function vapidAuthorization(endpoint:string,env:PushEnv,now=Date.now()) {
  const publicKey = pushBytes(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey('jwk',{
    kty:'EC',crv:'P-256',x:pushBase64(publicKey.slice(1,33)),y:pushBase64(publicKey.slice(33)),
    d:env.VAPID_PRIVATE_KEY!,ext:true,
  },{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const header = pushBase64(text.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const claims = pushBase64(text.encode(JSON.stringify({aud:new URL(endpoint).origin,exp:Math.floor(now/1000)+12*3600,sub:env.VAPID_SUBJECT})));
  const content = header+'.'+claims;
  const signature = new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,text.encode(content)));
  return 'vapid t='+content+'.'+pushBase64(signature)+', k='+env.VAPID_PUBLIC_KEY;
}
