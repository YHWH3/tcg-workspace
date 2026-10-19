import type {Env,AuthUser} from './auth';
import {levelSql} from './capability';
import {randomToken,sha256Hex} from './password';
/** The issuer must retain current administration capability at redemption. */
export const usableInviteSql=(alias='i')=>`(SELECT enabled FROM access_state WHERE id=1)=1 AND ${alias}.revoked_at IS NULL AND ${alias}.used_by IS NULL AND ${alias}.expires_at>? AND ${levelSql(`${alias}.created_by`,`${alias}.space_id`)}>=4 AND NOT EXISTS(SELECT 1 FROM spaces ds WHERE ds.id=${alias}.space_id AND ds.guest_directory_restricted=1)`;
export function sessionGuard(db:D1Database,user:AuthUser){return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL) THEN 1 ELSE json_extract('{','$') END`).bind(user.tokenHash,user.id,Date.now());}
export async function makeGuestInvite(env:Env,user:AuthUser,space:string,role:string){
 if(!['viewer','commenter','editor'].includes(role))throw new Error('invalid_role');
 const token=randomToken(),id=crypto.randomUUID(),now=Date.now();
 const result=await env.DB.batch([sessionGuard(env.DB,user),env.DB.prepare(`INSERT INTO guest_invites(id,token_hash,space_id,role,created_by,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT enabled FROM access_state WHERE id=1)=1 AND ${levelSql('?','?')}>=4 AND NOT EXISTS(SELECT 1 FROM spaces ds WHERE ds.id=? AND ds.guest_directory_restricted=1) AND (SELECT COUNT(*) FROM guest_invites WHERE space_id=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?)<50`).bind(id,await sha256Hex(token),space,role,user.id,now,now+7*86400000,space,user.id,space,space,now),env.DB.prepare(`INSERT INTO access_audit(id,actor_id,space_id,action,after_json,generation,created_at) SELECT ?,?,?,'invite_guest',?,generation,? FROM access_state WHERE id=1 AND changes()=1`).bind(crypto.randomUUID(),user.id,space,JSON.stringify({inviteId:id,role}),now)]);
 return result[1].meta.changes?{id,token,expiresAt:now+7*86400000}:null;
}
export async function acceptGuestInvite(env:Env,user:AuthUser,token:string){
 const hash=await sha256Hex(token),now=Date.now();
 const i=await env.DB.prepare(`SELECT id,space_id,role,used_by FROM guest_invites WHERE token_hash=?`).bind(hash).first<{id:string;space_id:string;role:string;used_by:string|null}>();
 if(!i)return null;
 // A lost-response retry is acknowledged only while the same grant remains live.
 if(i.used_by===user.id){const valid=await env.DB.prepare(`SELECT 1 FROM guest_invites i JOIN space_members m ON m.space_id=i.space_id AND m.user_id=? WHERE i.id=? AND i.revoked_at IS NULL AND m.access='allow' AND m.role=i.role AND ${levelSql('i.created_by','i.space_id')}>=4 AND ${levelSql('?','i.space_id')}>=1`).bind(user.id,i.id,user.id).first();return valid?{spaceId:i.space_id,replayed:true}:null;}
 const result=await env.DB.batch([sessionGuard(env.DB,user),env.DB.prepare(`INSERT INTO space_members(space_id,user_id,role,access,updated_at) SELECT space_id,?,role,'allow',? FROM guest_invites i WHERE i.id=? AND ${usableInviteSql()} AND NOT EXISTS(SELECT 1 FROM space_members WHERE space_id=i.space_id AND user_id=?)`).bind(user.id,now,i.id,now,user.id),env.DB.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{','$') END`),env.DB.prepare('UPDATE guest_invites SET used_by=?,used_at=? WHERE id=?').bind(user.id,now,i.id),env.DB.prepare(`INSERT INTO access_audit(id,actor_id,space_id,target_user_id,action,after_json,generation,created_at) SELECT ?,?,? ,?,'accept_guest_invite',?,generation,? FROM access_state WHERE id=1`).bind(crypto.randomUUID(),user.id,i.space_id,user.id,JSON.stringify({inviteId:i.id,role:i.role}),now)]).catch(()=>null);
 return result?{spaceId:i.space_id,replayed:false}:null;
}
