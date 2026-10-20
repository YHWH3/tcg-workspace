/** BYOK credential storage: AES-256-GCM with the operator secret
 * AI_CREDENTIAL_KEY, AAD bound to `user:provider` so a ciphertext copied to
 * another user/provider row cannot decrypt. Plaintext keys never leave the
 * Worker: no API returns them, no log contains them. */
import type {Env} from '../auth';
import type {ProviderModel} from '../../shared/assistantProtocol';

const b64=(u:Uint8Array)=>btoa(String.fromCharCode(...u));
const unb64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));

async function key(env:Env):Promise<CryptoKey|null>{
 if(!env.AI_CREDENTIAL_KEY)return null;
 let raw:Uint8Array;try{raw=unb64(env.AI_CREDENTIAL_KEY);}catch{return null;}
 if(raw.length!==32)return null;
 return crypto.subtle.importKey('raw',raw as unknown as BufferSource,'AES-GCM',false,['encrypt','decrypt']);
}
const aad=(userId:string,provider:string)=>new TextEncoder().encode(`tcg-assistant-credential:v1:${userId}:${provider}`);

export async function saveCredential(env:Env,userId:string,provider:string,secret:string,models:ProviderModel[]):Promise<boolean>{
 const k=await key(env);if(!k)return false;
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(userId,provider)},k,new TextEncoder().encode(secret)));
 await env.DB.prepare(`INSERT INTO assistant_credentials(user_id,provider,ciphertext,iv,key_version,models_json,created_at) VALUES(?,?,?,?,1,?,?)
  ON CONFLICT(user_id,provider) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,key_version=1,models_json=excluded.models_json,created_at=excluded.created_at,last_used_at=NULL`)
  .bind(userId,provider,b64(ct),b64(iv),JSON.stringify(models),Date.now()).run();
 return true;
}

export async function loadCredential(env:Env,userId:string,provider:string):Promise<string|null>{
 const row=await env.DB.prepare('SELECT ciphertext,iv FROM assistant_credentials WHERE user_id=? AND provider=?').bind(userId,provider).first<{ciphertext:string;iv:string}>();
 const k=await key(env);if(!row||!k)return null;
 try{
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(row.iv) as unknown as BufferSource,additionalData:aad(userId,provider)},k,unb64(row.ciphertext) as unknown as BufferSource);
  return new TextDecoder().decode(pt);
 }catch{return null;}
}

export async function credentialViews(env:Env,userId:string):Promise<Map<string,{configured:boolean;models:ProviderModel[]}>>{
 const rows=(await env.DB.prepare('SELECT provider,models_json FROM assistant_credentials WHERE user_id=?').bind(userId).all<{provider:string;models_json:string}>()).results;
 return new Map(rows.map(r=>[r.provider,{configured:true,models:(()=>{try{return JSON.parse(r.models_json) as ProviderModel[];}catch{return [];}})()}]));
}

export async function deleteCredential(env:Env,userId:string,provider:string){
 await env.DB.prepare('DELETE FROM assistant_credentials WHERE user_id=? AND provider=?').bind(userId,provider).run();
}
