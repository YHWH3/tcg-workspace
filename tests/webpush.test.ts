import {expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {encryptPush,isPushEndpoint,pushBase64,pushBytes,pushMode,vapidAuthorization} from '../worker/webpush';

// Published RFC 8291 Section 5 / Appendix A inputs, never operational keys.
const receiverPublic='BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const authSecret='BTBZMqHH6r4Tts7J_aSIgg';
const senderPublic='BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

it('matches the RFC 8291 encrypted record and header byte for byte',async()=>{
  const raw=pushBytes(senderPublic);
  const privateKey=await crypto.subtle.importKey('jwk',{
    kty:'EC',crv:'P-256',x:pushBase64(raw.slice(1,33)),y:pushBase64(raw.slice(33)),
    d:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  },{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const publicKey=await crypto.subtle.importKey('raw',raw,{name:'ECDH',namedCurve:'P-256'},true,[]);
  const encrypted=await encryptPush(receiverPublic,authSecret,
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),{
      keyPair:{privateKey,publicKey},salt:pushBytes('DGv6ra1nlYgDCS1FRnbzlw'),
    });
  expect(pushBase64(encrypted.slice(0,86))).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  expect(pushBase64(encrypted.slice(86))).toBe('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
});
it('creates a verifiable RFC 8292 token with a bounded expiry and exact audience',async()=>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
  const env={VAPID_PUBLIC_KEY:pushBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))),
    VAPID_PRIVATE_KEY:jwk.d,VAPID_SUBJECT:'mailto:fixture@example.test'};
  const now=Date.parse('2026-11-15T00:00:00Z');
  const header=await vapidAuthorization('https://fcm.googleapis.com/send/private',env,now);
  const token=header.slice('vapid t='.length).split(', k=')[0];
  const [algorithm,claims,signature]=token.split('.');
  expect(JSON.parse(new TextDecoder().decode(pushBytes(claims)))).toEqual({
    aud:'https://fcm.googleapis.com',exp:now/1000+12*3600,sub:env.VAPID_SUBJECT,
  });
  expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,pushBytes(signature),
    new TextEncoder().encode(algorithm+'.'+claims))).toBe(true);
});
it.each(['http://fcm.googleapis.com/send','https://fcm.googleapis.com.evil.test/send','https://evil.test/','https://user@web.push.apple.com/p','https://127.0.0.1/p','https://fcm.googleapis.com:444/p','https://web.push.apple.com/p#fragment'])('refuses unapproved endpoint %s',endpoint=>{
  expect(isPushEndpoint(endpoint)).toBe(false);
});
it.each(['https://fcm.googleapis.com/p','https://updates.push.services.mozilla.com/p','https://web.push.apple.com/p','https://wns1.notify.windows.com/p'])('accepts approved push services %s',endpoint=>{
  expect(isPushEndpoint(endpoint)).toBe(true);
});
it('keeps simulated egress confined to a disposable sink',()=>{
  expect(pushMode({WEB_PUSH:'simulated',PUSH_TEST_SINK:{fetch:async()=>new Response()}})).toBeNull();
  expect(pushMode({WEB_PUSH:'off'})).toBeNull();
});

it('runs the encryption vector inside the configured Worker runtime',async()=>{
  const bundle=buildSync({
    stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),contents:`
      import {encryptPush,pushBytes,pushBase64} from './worker/webpush';
      export default {async fetch(){
        const raw=pushBytes(${JSON.stringify(senderPublic)});
        const privateKey=await crypto.subtle.importKey('jwk',{
          kty:'EC',crv:'P-256',x:pushBase64(raw.slice(1,33)),y:pushBase64(raw.slice(33)),
          d:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'
        },{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
        const publicKey=await crypto.subtle.importKey('raw',raw,{name:'ECDH',namedCurve:'P-256'},true,[]);
        const result=await encryptPush(${JSON.stringify(receiverPublic)},${JSON.stringify(authSecret)},
          new TextEncoder().encode('When I grow up, I want to be a watermelon'),{
            keyPair:{privateKey,publicKey},salt:pushBytes('DGv6ra1nlYgDCS1FRnbzlw')
          });
        return new Response(pushBase64(result.slice(86)));
      }};
    `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',
  }).outputFiles[0].text;
  const runtime=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'crypto-fixture',modules:true,script:bundle,compatibilityDate:'2026-09-25',
  }]}));
  try{
    const response=await runtime.dispatchFetch('http://crypto-fixture.test/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
  }finally{await runtime.dispose();}
});
