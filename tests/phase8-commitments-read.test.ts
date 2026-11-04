import {beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../src/core/api',async original=>({...await original<typeof import('../src/core/api')>(),api:mock.api}));
import {ApiError} from '../src/core/api';
import {readServerCommitments} from '../src/core/commitmentsRead';
import {commitmentsConfigSchema} from '../shared/commitmentsConfig';
const config=commitmentsConfigSchema.parse({databaseId:'meetings'}),page={projects:[{id:'project'}]};
beforeEach(()=>{mock.api.mockReset();});
it('returns a normal source snapshot without another request',async()=>{
 mock.api.mockResolvedValue({pages:[page]});expect(await readServerCommitments(config,()=>true)).toEqual(page);expect(mock.api).toHaveBeenCalledTimes(1);
});
it('recovers exactly once from an explicitly changed snapshot in the current account',async()=>{
 mock.api.mockRejectedValueOnce(new ApiError(409,'commitment_sources_changed')).mockResolvedValueOnce({pages:[page]});expect(await readServerCommitments(config,()=>true)).toEqual(page);expect(mock.api).toHaveBeenCalledTimes(2);
});
it('surfaces a repeated source race instead of looping or returning an empty success',async()=>{
 mock.api.mockRejectedValue(new ApiError(409,'commitment_sources_changed'));await expect(readServerCommitments(config,()=>true)).rejects.toThrow('commitment_sources_changed');expect(mock.api).toHaveBeenCalledTimes(2);
});
it('never retries changed account/access generations or unrelated failures',async()=>{
 for(const [error,current]of [[new ApiError(409,'commitment_sources_changed'),false],[new ApiError(503,'unavailable'),true],[new ApiError(401,'unauthenticated'),true],[new ApiError(0,'offline'),true],[new ApiError(409,'other_conflict'),true]] as const){mock.api.mockReset().mockRejectedValue(error);await expect(readServerCommitments(config,()=>current)).rejects.toBe(error);expect(mock.api).toHaveBeenCalledTimes(1);}
});
