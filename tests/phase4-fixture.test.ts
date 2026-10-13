import {createServer} from 'node:net';
import {afterEach,describe,it,expect} from 'vitest';
// The fixture is a Node CLI module and intentionally lives outside TS compilation.
// @ts-expect-error JavaScript orchestration helper has no declaration file.
import {assertLocal,assertPortAvailable,assertOwnedPort,command,fixtureEnvironment,redactFixtureLog,startFixture} from '../scripts/phase4-fixture.mjs';

const originalToken=process.env.CLOUDFLARE_API_TOKEN;
afterEach(()=>{if(originalToken===undefined)delete process.env.CLOUDFLARE_API_TOKEN;else process.env.CLOUDFLARE_API_TOKEN=originalToken;});
const quiet={write:()=>{}};
describe('disposable Worker fixture safety',()=>{
  it('rejects remote URLs and embedded credentials',()=>{
    for(const base of ['https://localhost','http://example.com','http://127.0.0.1.example.com','http://admin:secret@127.0.0.1'])expect(()=>assertLocal(base)).toThrow();
    expect(assertLocal('http://127.0.0.1:8799')).toBe('http://127.0.0.1:8799');
  });
  it('reports collisions without terminating the port owner',async()=>{
    const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    try {await expect(assertPortAvailable(port)).rejects.toThrow(/unavailable/);await expect(startFixture({port,build:false})).rejects.toThrow(/unavailable/);expect(server.listening).toBe(true);expect(()=>assertOwnedPort(port,99999999)).toThrow(/another process group/);}
    finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('rejects invalid ports before fixture mutation',async()=>{
    for(const port of [0,80,65536,1.5])await expect(assertPortAvailable(port)).rejects.toThrow(/Invalid/);
  });
  it('scrubs inherited cloud credentials and token-bearing logs',()=>{
    process.env.CLOUDFLARE_API_TOKEN='fixture-secret';expect(fixtureEnvironment().CLOUDFLARE_API_TOKEN).toBeUndefined();
    const result=redactFixtureLog('Bearer abc123 {"access_token":"secret","password":"secret"}');
    expect(result).not.toContain('abc123');expect(result).not.toContain('secret');
  });
  it('records process failure and pre-assertion throw',async()=>{
    await expect(command([process.execPath,'-e','process.exit(1)'],{log:quiet})).rejects.toThrow(/exited 1/);
    await expect(command([process.execPath,'-e','throw new Error("before assertions")'],{log:quiet})).rejects.toThrow(/before assertions/);
  });
  it('returns exit evidence for a successful command',async()=>{
    const result=await command([process.execPath,'-e','console.log("fixture success")'],{log:quiet});
    expect(result.code).toBe(0);expect(result.output).toContain('fixture success');expect(result.durationMs).toBeGreaterThan(0);
  });
  it('reports a timeout and terminates owned children holding output pipes',async()=>{
    const result=command([process.execPath,'-e','require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000)'],{timeout:150,log:quiet});
    await expect(result).rejects.toThrow(/timed out after 150ms/);
  },5000);
});
