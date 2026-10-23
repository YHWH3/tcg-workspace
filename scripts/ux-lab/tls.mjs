import {existsSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

// Local test-process trust only. Supplied certificates are never overwritten.
export function ensureLabTls(tls,{provided=false}={}){
  const present=existsSync(tls.cert)&&existsSync(tls.key);
  const validFor=seconds=>present&&spawnSync('openssl',['x509','-checkend',String(seconds),'-noout','-in',tls.cert],{stdio:'ignore'}).status===0;
  if(provided){
    if(!present)throw new Error('Configured local certificate files are missing');
    if(!validFor(0))throw new Error('Configured local certificate is expired or invalid');
    return false;
  }
  if(validFor(86400)){chmodSync(tls.key,0o600);return false;}
  mkdirSync(dirname(tls.cert),{recursive:true,mode:0o700});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','7','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',tls.key,'-out',tls.cert],{stdio:'ignore'});
  chmodSync(tls.key,0o600);
  return true;
}
