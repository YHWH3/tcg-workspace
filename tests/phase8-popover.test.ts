import {it,expect} from 'vitest';
import {placePopover} from '../src/core/popoverPosition';
const viewport={width:820,height:1180};
it('opens footer account menus above their trigger with every action visible',()=>{
 const trigger={left:8,right:232,top:1090,bottom:1130,width:224};
 const p=placePopover(trigger,{width:224,height:190},viewport,'left');
 expect(p).toEqual({left:8,top:896,width:224});expect(p.top+190).toBeLessThan(trigger.top);
});
it('keeps normal toolbar placement and clamps wider right-aligned panels',()=>{
 const trigger={left:760,right:804,top:20,bottom:64,width:44};
 expect(placePopover(trigger,{width:320,height:200},viewport,'right')).toEqual({left:484,top:68,width:176});
});
it('repositions growing content and clamps tall panels inside the viewport',()=>{
 const trigger={left:30,right:230,top:500,bottom:540,width:200};
 expect(placePopover(trigger,{width:220,height:100},viewport,'left').top).toBe(544);
 expect(placePopover(trigger,{width:220,height:900},viewport,'left').top).toBe(272);
});
