import {afterEach,it,expect} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {usageApi} from '../worker/usage';
let f:AuditFixture;afterEach(async()=>f?.dispose());
it('reports measured D1 allocation, payload growth and non-destructive retention only to workspace administrators',async()=>{f=await openAuditFixture();const r=await usageApi.request('/',{headers:f.auth('alice')},f.env,f.ctx);expect(r.status).toBe(200);const data=await r.json() as any;expect(data.d1AllocatedBytes).toBeGreaterThan(0);expect(data.retention.automaticPurge).toBe(false);expect(data.rowsWritten).toBe(0);expect((await usageApi.request('/',{headers:f.auth('bob')},f.env,f.ctx)).status).toBe(404);});
