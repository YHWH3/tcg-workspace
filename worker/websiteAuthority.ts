import type {Env} from './auth';
import {loadAccessContext,spaceAccess} from './access';
import {canEdit} from '../shared/access';
import {levelSql} from './capability';
import {WEBSITE_INBOX_ID,WEBSITE_PEOPLE_ID} from '../shared/websiteInbox';

export interface WebsiteGrant {sponsor_id:string;space_id:string;inbox_id:string;people_id:string;version:number;revoked_at:number|null}
export async function websiteAuthority(env:Env):Promise<WebsiteGrant|null> {
 const grant=await env.DB.prepare(`SELECT g.* FROM website_ingest_grant g JOIN users u ON u.id=g.sponsor_id
 WHERE g.id=1 AND g.revoked_at IS NULL AND u.disabled_at IS NULL AND COALESCE(u.workspace_role,u.role)!='guest'`).first<WebsiteGrant>();
 if(!grant||grant.inbox_id!==WEBSITE_INBOX_ID)return null;
 const access=await loadAccessContext(env.DB,grant.sponsor_id,[grant.space_id]);
 if(!canEdit(spaceAccess(access,grant.space_id)))return null;
 const wrong=await env.DB.prepare(`SELECT id FROM records WHERE id IN (?,?) AND
 (collection!='boards' OR space_id!=? OR COALESCE(json_extract(data,'$.deleted'),0)=1 OR COALESCE(json_extract(data,'$.archived'),0)=1) LIMIT 1`)
 .bind(grant.inbox_id,grant.people_id,grant.space_id).first();
 return wrong?null:grant;
}
export function websiteGrantFence(env:Env,g:WebsiteGrant) {
 return env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM website_ingest_grant g WHERE g.id=1 AND g.version=? AND g.sponsor_id=?
 AND g.revoked_at IS NULL AND ${levelSql('g.sponsor_id','g.space_id')}>=3)
 AND NOT EXISTS(SELECT 1 FROM records WHERE id IN (?,?) AND (space_id!=? OR COALESCE(json_extract(data,'$.deleted'),0)=1 OR COALESCE(json_extract(data,'$.archived'),0)=1))
 THEN 1 ELSE json_extract('{','$') END`).bind(g.version,g.sponsor_id,g.inbox_id,g.people_id,g.space_id);
}
export const defaultWebsiteDestinations={inboxId:WEBSITE_INBOX_ID,peopleId:WEBSITE_PEOPLE_ID};
