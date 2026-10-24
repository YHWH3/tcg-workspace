import fc from 'fast-check';
import {randomUUID} from 'node:crypto';
import {test,expect,fixture,request,health,readRecord,setOfflineForTest} from './support.mjs';
const titles=['UX café 👩🏽‍💻','UX العربية é 日本語','UX '+('long-answer-'.repeat(12))];
class Action{
  constructor(kind,value){this.kind=kind;this.value=value;}
  check(){return true;}
  toString(){return JSON.stringify({kind:this.kind,value:this.value});}
  async run(model,real){
    const {page,context,info}=real;
    if(this.kind==='stage'){
      await page.getByRole('combobox',{name:'Stage',exact:true}).selectOption(this.value);model.stage=this.value;
    }else if(this.kind==='title'||this.kind==='offline-edit'){
      if(this.kind==='offline-edit')await setOfflineForTest(page,context,true);
      const title=page.getByRole('textbox',{name:'Task title',exact:true});await title.fill(this.value);await title.press('Tab');model.title=this.value;
      await expect(title).toHaveValue(model.title);
      if(this.kind==='offline-edit')await setOfflineForTest(page,context,false);
    }else if(this.kind==='reload'){
      await synced(model,real);await page.reload();
    }else if(this.kind==='theme')await page.emulateMedia({colorScheme:this.value});
    else if(this.kind==='resize')await page.setViewportSize({width:this.value,height:900});
    else if(this.kind==='search'){
      // Compact task details are modal: do not force focus into the inert shell.
      const title=page.getByRole('textbox',{name:'Task title',exact:true});await title.focus();await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('combobox',{name:'Search workspace',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(title).toBeFocused();
    }
    await expect(page.getByRole('textbox',{name:'Task title',exact:true})).toHaveValue(model.title);
    await expect(page.getByRole('combobox',{name:'Stage',exact:true})).toHaveValue(model.stage);
    await health(page,'exploration '+this.kind,info,{axe:false});
    real.executed.push(this.toString());
  }
}
async function synced(model,{taskId}){
  await expect.poll(async()=>{
    const rec=await readRecord(taskId);return rec?{title:rec.data?.title??rec.title,status:rec.data?.status??rec.status}:null;
  },{timeout:20_000,message:'Local edit must reach the disposable server before reload'}).toEqual({title:model.title,status:model.stage});
}
test('seeded interaction exploration: edit, offline, reload, resize, theme and search',async({page,context},info)=>{
  test.setTimeout(180_000);
  const seed=Number(process.env.UX_SEED??20261023),executed=[];
  const arbitrary=fc.oneof(
    fc.constantFrom('todo','done').map(v=>new Action('stage',v)),
    fc.constantFrom(...titles).map(v=>new Action('title',v)),
    fc.constantFrom(...titles).map(v=>new Action('offline-edit',v)),
    fc.constant(new Action('reload')),fc.constant(new Action('search')),
    fc.constantFrom('light','dark').map(v=>new Action('theme',v)),
    fc.constantFrom(320,390,640,767,768,820,1024,1440).map(v=>new Action('resize',v)),
  );
  // Arrays make shrinking and replay use just seed/path; no hidden command replayPath.
  const result=await fc.check(fc.asyncProperty(fc.array(arbitrary,{minLength:6,maxLength:14}),async commands=>{
    await context.setOffline(false);await page.emulateMedia({colorScheme:info.project.use.colorScheme});await page.setViewportSize(info.project.use.viewport);
    const taskId='ux-'+randomUUID(),model={title:'UX scenario',stage:'todo'};
    await request('/api/sync/push',{protocol:3,changes:[{id:taskId,collection:'tasks',ts:Date.now(),patch:{boardId:'ux-tasks',title:model.title,status:model.stage,order:'a0'}}]});
    const path='/boards/ux-tasks/tasks/'+taskId;await page.goto(fixture.base+path);await expect(page.getByRole('textbox',{name:'Task title',exact:true})).toHaveValue(model.title);
    await fc.asyncModelRun(()=>({model,real:{page,context,info,path,taskId,executed}}),commands);
    await synced(model,{taskId});
  }),{seed,numRuns:Number(process.env.UX_RUNS??3),...(process.env.UX_PATH?{path:process.env.UX_PATH}:{}),verbose:1});
  const report={seed:result.seed,path:result.counterexamplePath,failed:result.failed,numRuns:result.numRuns,numShrinks:result.numShrinks,actions:executed,counterexample:result.counterexample?.[0]?.map(c=>c.toString()),error:result.errorInstance?.message??null,replay:`UX_SEED=${result.seed} UX_PATH='${result.counterexamplePath??''}' npm run qa:ux -- --project=${info.project.name} --grep='seeded interaction'`};
  await info.attach('exploration-replay.json',{body:JSON.stringify(report,null,2),contentType:'application/json'});
  expect(result.failed,JSON.stringify(report,null,2)).toBe(false);
});
