import {describe,expect,it,vi} from 'vitest';
import {approvedRemoteUrl} from '../worker/remotePolicy';
import {importFileFromUrl} from '../worker/remotefile';
import type {Env} from '../worker/auth';
describe('Phase 6 network exfiltration boundary',()=>{
 it.each(['https://127.0.0.1/x','https://[::1]/x','https://media.example.org/?secret=workspace','https://user:pass@media.example.org/x','https://evil.example.org/x','http://media.example.org/x','https://media.example.org:8080/x','https://media.example.org./x'])('rejects unapproved destination %s',u=>expect(()=>approvedRemoteUrl(u,['media.example.org'],true)).toThrow());
 it('requires human consent even on a trusted host',()=>expect(()=>approvedRemoteUrl('https://media.example.org/x',['media.example.org'],false)).toThrow('human_consent'));
 it('permits only an exact trusted HTTPS URL without query or credentials',()=>expect(approvedRemoteUrl('https://media.example.org/image.png',['media.example.org'],true).pathname).toBe('/image.png'));
 it('performs no network operation for an MCP-supplied URL',async()=>{
  const network=vi.spyOn(globalThis,'fetch');await expect(importFileFromUrl({} as Env,'https://evil.example.org/?secret=private',{userId:'a',parentId:'p',parentType:'block'})).rejects.toThrow('human_consent');expect(network).not.toHaveBeenCalled();network.mockRestore();
 });
 it('never follows a redirect from an approved host',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:302,headers:{location:'https://127.0.0.1/secret'}}));
  await expect(importFileFromUrl({REMOTE_IMPORT_HOSTS:'media.example.org'} as Env,'https://media.example.org/image.png',{userId:'a',parentId:'p',parentType:'block',humanApproved:true})).rejects.toThrow('remote_redirect_not_allowed');expect(network).toHaveBeenCalledTimes(1);expect(network.mock.calls[0][1]?.redirect).toBe('manual');network.mockRestore();
 });
});
