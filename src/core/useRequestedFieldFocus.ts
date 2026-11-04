import {useEffect,useRef,type RefObject} from 'react';
import {useLocation} from 'react-router';
import type {FieldDef} from '../../shared/fields';
/** A deliberate record link may request one configured field. The intent is
 * consumed only after that control mounts; ordinary sync cannot refocus it. */
export function useRequestedFieldFocus(root:RefObject<HTMLDivElement|null>,recordId:string|undefined,fields:FieldDef[]){
 const location=useLocation(),consumed=useRef<string|null>(null),fieldKey=new URLSearchParams(location.search).get('focusField'),signature=fields.map(f=>`${f.type}:${f.id}`).join('|');
 useEffect(()=>{
  if(!recordId||!fieldKey||!fields.some(f=>`${f.type==='relation'?'rel':'p'}_${f.id}`===fieldKey))return;
  const intent=JSON.stringify([location.key,recordId,fieldKey]);if(consumed.current===intent||!root.current)return;
  const container=root.current;let frame=0;
  const focus=()=>{
   if(consumed.current===intent)return;
   const row=[...container.querySelectorAll<HTMLElement>('[data-record-field]')].find(el=>el.dataset.recordField===fieldKey),control=row?.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex="0"]');
   if(!control||!control.getClientRects().length)return;
   control.focus();control.scrollIntoView({block:'nearest'});if(document.activeElement===control)consumed.current=intent;
  };
  frame=requestAnimationFrame(focus);const observer=new MutationObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(focus);});observer.observe(container,{childList:true,subtree:true});
  return()=>{cancelAnimationFrame(frame);observer.disconnect();};
 },[location.key,fieldKey,recordId,signature,root]);
}
