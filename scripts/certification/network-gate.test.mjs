import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createNetworkGate} from './network-gate.mjs';

test('network gate rejects non-loopback destinations and credential-bearing URLs',async()=>{
 for(const url of ['https://example.com','http://localhost:1234','http://secret@127.0.0.1:1234','http://127.0.0.1:1234/path'])await assert.rejects(createNetworkGate(url));
});
test('real network cut fails reads without changing navigator state and recovers',async()=>{
 const backend=http.createServer((req,res)=>{res.end(req.url);});backend.listen(0,'127.0.0.1');await once(backend,'listening');
 const gate=await createNetworkGate(`http://127.0.0.1:${backend.address().port}`);
 try{
  assert.equal(await(await fetch(gate.base+'/before')).text(),'/before');gate.setAvailable(false);
  await assert.rejects(fetch(gate.base+'/cut',{signal:AbortSignal.timeout(2000)}));gate.setAvailable(true);
  assert.equal(await(await fetch(gate.base+'/after')).text(),'/after');
 }finally{await gate.stop();backend.closeAllConnections();await new Promise(r=>backend.close(r));}
});
test('network cut closes an upgraded socket and its upstream peer',async()=>{
 const backend=http.createServer();let peerClosed,peer;
 const closed=new Promise(r=>peerClosed=r);
 backend.on('upgrade',(req,socket)=>{peer=socket;socket.resume();socket.on('end',()=>socket.destroy());socket.on('error',()=>{});socket.on('close',peerClosed);socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');});
 backend.listen(0,'127.0.0.1');await once(backend,'listening');const gate=await createNetworkGate(`http://127.0.0.1:${backend.address().port}`);
 const client=net.connect(Number(new URL(gate.base).port),'127.0.0.1');client.on('error',()=>{});
 try{
  await once(client,'connect');client.write('GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
  assert.match(String((await once(client,'data'))[0]),/101 Switching Protocols/);
  const ended=once(client,'close');gate.setAvailable(false);await ended;
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Upstream upgraded peer leaked')),2000).unref())]);
 }finally{client.destroy();peer?.destroy();await gate.stop();await new Promise(r=>backend.close(r));}
});
