/** Disposable local verifiers act as their fixture human: complete both consent
 * steps and explicitly select the spaces offered by the authenticated server.
 * No credentials, cookies or consent secrets are logged. Never used by app code. */
export async function fixtureFetch(input, init) {
  const response=await fetch(input,init);
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(init?.method!=='POST'||url.pathname!=='/oauth/authorize'||response.status!==200)return response;
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Fixture consent requires loopback');
  const html=await response.clone().text();
  const selection=html.match(/name="selection" value="([^"]+)"/)?.[1];
  if(!selection)return response;
  const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];
  if(!handle)throw new Error('Scope selection is missing consent handle');
  const form=new URLSearchParams({handle,selection,decision:'allow'});
  for(const m of html.matchAll(/name="spaces" value="([^"]+)"/g))form.append('spaces',m[1]);
  return fetch(input,{...init,body:form});
}
