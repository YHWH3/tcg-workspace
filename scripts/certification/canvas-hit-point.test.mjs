import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium,firefox,webkit} from 'playwright';
import {canvasBodyPoint} from '../canvas-hit-point.mjs';

for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 test(`${name}: canvas drag starts on exposed body, never controls or a covered item`,async()=>{
  const browser=await engine.launch();
  try{
   const page=await browser.newPage({viewport:{width:800,height:600}});
   await page.setContent(`<style>body{margin:0}.item{position:absolute;left:50px;top:50px;width:300px;height:200px}.body{width:100%;height:100%}.cover{position:absolute;left:50px;top:50px;width:210px;height:80px;z-index:2}button{position:absolute;right:0;top:0;width:40px;height:40px}.coverAll{position:absolute;inset:0;z-index:3}</style><div class="item" data-mooditem="fixture"><div class="body">Canvas body</div><button aria-label="Comments">Comment</button></div><div class="cover">Higher item</div>`);
   const point=await page.evaluate(canvasBodyPoint,'fixture');assert.ok(point);
   const hit=await page.evaluate(({x,y})=>({control:!!document.elementFromPoint(x,y)?.closest('button,input,textarea,select,a,[role="button"],[contenteditable="true"],[data-testid="resize-handle"]'),item:document.elementFromPoint(x,y)?.closest('[data-mooditem]')?.getAttribute('data-mooditem')}),point);
   assert.equal(hit.control,false,'A comment button cannot initiate a canvas body drag');assert.equal(hit.item,'fixture');
   // Other exposed controls are equally unsuitable; an all-control body has no
   // draggable point. An occluded item is never force-clicked through its cover.
   for(const child of ['<textarea style="width:100%;height:100%"></textarea>','<div role="button" style="width:100%;height:100%">Action</div>','<div contenteditable="true" style="width:100%;height:100%">Edit</div>','<span data-testid="resize-handle" style="display:block;width:100%;height:100%"></span>']){
    await page.locator('.cover').evaluateAll(els=>els.forEach(el=>el.remove()));await page.locator('[data-mooditem]').evaluate((el,html)=>{el.innerHTML=html;},child);assert.equal(await page.evaluate(canvasBodyPoint,'fixture'),null);
   }
   await page.locator('[data-mooditem]').evaluate(el=>{el.innerHTML='<div class="body">Body</div>';});
   await page.evaluate(()=>{const cover=document.createElement('div');cover.className='coverAll';document.body.append(cover);});
   assert.equal(await page.evaluate(canvasBodyPoint,'fixture'),null);assert.equal(await page.evaluate(canvasBodyPoint,'missing'),null);
  }finally{await browser.close();}
 });
}
