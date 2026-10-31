/** In-memory reads only: superseded/account/session/access responses are discarded. */
export interface CurrentRead<T>{value:T|null;loading:boolean;error:boolean}
export function createCurrentRead<T>(options:{current:()=>boolean;request:()=>Promise<T>;publish:(state:CurrentRead<T>)=>void}){
 let generation=0,disposed=false;
 const valid=(g:number)=>!disposed&&generation===g&&options.current();
 return {
  async load(){
   const g=++generation;if(!valid(g))return;
   options.publish({value:null,loading:true,error:false});
   try{const value=await options.request();if(valid(g))options.publish({value,loading:false,error:false});}
   catch{if(valid(g))options.publish({value:null,loading:false,error:true});}
  },
  dispose(){disposed=true;generation++;},
 };
}
