// Owner-run local generation. Keep the private value in approved secret storage.
const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const jwk = await crypto.subtle.exportKey('jwk',pair.privateKey);
const raw = await crypto.subtle.exportKey('raw',pair.publicKey);
console.log('VAPID_PUBLIC_KEY='+Buffer.from(raw).toString('base64url'));
console.log('VAPID_PRIVATE_KEY='+jwk.d);
