// Injected into the owned disposable fixture only; never shipped in app assets.
// No credentials, source text, input values or request bodies are collected.
const sink=__PROBE_SINK__;
const events=[];let prior='',sequence=0;
const nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input),location.href);
 if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return nativeFetch(input,init);
 const method=init?.method??(input instanceof Request?input.method:'GET');
 const record=value=>{events.push({type:'api',method,path:url.pathname,...value});if(events.length>40)events.shift();};
 return nativeFetch(input,init).then(response=>{if(!response.ok||url.pathname.startsWith('/api/auth/'))record({status:response.status});return response;},error=>{record({status:0,error:error.name});throw error;});
};
const identify=el=>el instanceof Element?{tag:el.tagName,id:el.getAttribute('data-testid')??el.id,role:el.getAttribute('role'),label:el.getAttribute('aria-label')}:null;
for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click','touchstart','touchend'])addEventListener(type,e=>{
 events.push({type,trusted:e.isTrusted,target:identify(e.target),pointerId:e.pointerId,pointerType:e.pointerType,x:e.clientX,y:e.clientY,touches:e.touches?.length});if(events.length>40)events.shift();
},{capture:true,passive:true});
setInterval(()=>{
 const canvas=document.querySelector('[data-testid="mood-canvas"]'),world=canvas?.querySelector(':scope > div:nth-child(2)'),approval=document.querySelector('[data-testid="assistant-approve"]');
 const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
 const hit=el=>{if(!el)return false;const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};
 const state={route:location.pathname,ready:document.readyState,editor:!!document.querySelector('[contenteditable="true"]'),canvas:rect(canvas),transform:world?.style.transform,viewport:{w:innerWidth,h:innerHeight,visualHeight:visualViewport?.height,scale:visualViewport?.scale},approval:{rect:rect(approval),hit:hit(approval)},events};
 const encoded=JSON.stringify(state);if(encoded===prior)return;prior=encoded;
 nativeFetch(sink,{method:'POST',body:JSON.stringify({sequence:++sequence,...state}),headers:{'Content-Type':'text/plain'},credentials:'omit'}).catch(()=>{});
},500);
