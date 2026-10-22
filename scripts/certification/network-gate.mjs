// Disposable loopback transport fault injection. Never targets a remote host.
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export async function createNetworkGate(backend,tls){
 const url=new URL(backend);assert.equal(url.hostname,'127.0.0.1');assert.ok(['http:','https:'].includes(url.protocol));assert.equal(url.pathname,'/');assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
 const transport=url.protocol==='https:'?https:http,sockets=new Set();let available=true,failedAssetPath=null;
 const server=(tls?https.createServer({key:readFileSync(tls.key),cert:readFileSync(tls.cert)}):http.createServer());
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('request',(req,res)=>{
  if(!available){req.socket.destroy();return;}
  if(failedAssetPath&&req.url.split('?')[0]===failedAssetPath){res.writeHead(503,{'Content-Type':'text/plain'});res.end('Injected required-asset failure');return;}
  const upstream=transport.request({hostname:url.hostname,port:url.port,path:req.url.startsWith('/')?req.url:'/',protocol:url.protocol,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>res.destroy());req.on('error',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
 server.on('upgrade',(req,socket,head)=>{
  if(!available){socket.destroy();return;}
  const upstream=transport.request({hostname:url.hostname,port:url.port,path:req.url.startsWith('/')?req.url:'/',protocol:url.protocol,method:req.method,headers:req.headers});
  upstream.on('upgrade',(response,peer,peerHead)=>{
   socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((text,h,i)=>text+h+(i%2?'\r\n':': '),'')}\r\n`);
   if(head.length)peer.write(head);if(peerHead.length)socket.write(peerHead);socket.pipe(peer).pipe(socket);socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
  });
  upstream.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);response.resume();});upstream.on('error',()=>socket.destroy());upstream.end();
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {base:`${tls?'https':'http'}://127.0.0.1:${server.address().port}`,setAssetFailure(path){assert.ok(path===null||typeof path==='string'&&path.startsWith('/assets/')&&!path.includes('?')&&!path.includes('#'));failedAssetPath=path;},setAvailable(value){available=value;if(!value)for(const socket of sockets)socket.destroy();},async stop(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
