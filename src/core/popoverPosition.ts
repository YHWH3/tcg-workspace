/** Viewport collision handling for desktop popovers; compact sheets own theirs. */
export function placePopover(trigger:{left:number;right:number;top:number;bottom:number;width:number},panel:{width:number;height:number},viewport:{width:number;height:number},align:'left'|'right'|'center'){
 const width=Math.max(176,trigger.width),panelWidth=Math.max(width,panel.width),inset=8,gap=4;
 const desiredLeft=align==='right'?trigger.right-panelWidth:align==='center'?trigger.left+(trigger.width-panelWidth)/2:trigger.left;
 const left=Math.max(inset,Math.min(desiredLeft,viewport.width-panelWidth-inset));
 const below=viewport.height-trigger.bottom-gap-inset,above=trigger.top-gap-inset;
 const desiredTop=panel.height>below&&above>below?trigger.top-gap-panel.height:trigger.bottom+gap;
 const top=Math.max(inset,Math.min(desiredTop,viewport.height-panel.height-inset));
 return {left,top,width};
}
