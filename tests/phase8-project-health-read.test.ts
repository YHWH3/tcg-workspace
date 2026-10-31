import {beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../src/core/api',async original=>({...await original<typeof import('../src/core/api')>(),api:mock.api}));
import {ApiError} from '../src/core/api';
import {readServerProjectHealth} from '../src/core/projectHealthRead';
import {projectHealthConfigSchema} from '../shared/projectHealthConfig';
const config=projectHealthConfigSchema.parse({databaseId:'projects'}),page={projects:[{id:'project'}]};
beforeEach(()=>{mock.api.mockReset();});
it('returns a normal source snapshot without another request',async()=>{
 mock.api.mockResolvedValue({pages:[page]});expect(await readServerProjectHealth(config,()=>true)).toEqual(page);expect(mock.api).toHaveBeenCalledTimes(1);
});
it('recovers exactly once from an explicitly changed snapshot in the current account',async()=>{
 mock.api.mockRejectedValueOnce(new ApiError(409,'project_sources_changed')).mockResolvedValueOnce({pages:[page]});expect(await readServerProjectHealth(config,()=>true)).toEqual(page);expect(mock.api).toHaveBeenCalledTimes(2);
});
it('surfaces a repeated source race instead of looping or returning an empty success',async()=>{
 mock.api.mockRejectedValue(new ApiError(409,'project_sources_changed'));await expect(readServerProjectHealth(config,()=>true)).rejects.toThrow('project_sources_changed');expect(mock.api).toHaveBeenCalledTimes(2);
});
it('never retries changed account/access generations or unrelated failures',async()=>{
 for(const [error,current]of [[new ApiError(409,'project_sources_changed'),false],[new ApiError(503,'unavailable'),true],[new ApiError(401,'unauthenticated'),true],[new ApiError(0,'offline'),true],[new ApiError(409,'other_conflict'),true]] as const){mock.api.mockReset().mockRejectedValue(error);await expect(readServerProjectHealth(config,()=>current)).rejects.toBe(error);expect(mock.api).toHaveBeenCalledTimes(1);}
});
