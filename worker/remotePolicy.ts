/** Network import is an explicit capability. Workspace content cannot authorize
 * requests. Exact operator-approved hosts only; redirects are never followed. */
export function approvedRemoteUrl(raw:string,hosts:readonly string[],humanApproved:boolean):URL {
 if(!humanApproved)throw new Error('remote_import_requires_human_consent');
 let u:URL;try{u=new URL(raw);}catch{throw new Error('invalid_remote_url');}
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.search||u.hash||u.hostname.endsWith('.')
  ||!hosts.includes(u.hostname)||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')
  ||/\.(localhost|local|internal|test|invalid)$/.test(u.hostname)||u.hostname==='localhost')throw new Error('remote_destination_not_allowed');
 return u;
}
