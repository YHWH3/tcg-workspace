import {expect,it} from 'vitest';
import {markdownBlockPatch,markdownToBlocks,blocksToMarkdown} from '../shared/markdown';
it('INT-06 mapper validates embeds and allowlists defined media fields',()=>{
 expect(()=>markdownBlockPatch({type:'embed',url:'javascript:alert(1)'})).toThrow('valid HTTP');
 const patch=markdownBlockPatch({type:'image',text:'caption',fileId:'file',caption:'Photo',width:640,height:480,duration:10,mime:'image/png',pageId:'untrusted',id:'untrusted'} as Parameters<typeof markdownBlockPatch>[0]);
 expect(patch).toEqual({type:'image',text:'caption',fileId:'file',caption:'Photo',width:640,height:480,duration:10,mime:'image/png'});
 expect(markdownBlockPatch(markdownToBlocks('![Caption](file:stored)')[0])).toMatchObject({fileId:'stored',caption:'Caption'});
 expect(blocksToMarkdown([{type:'image',fileId:'stored',caption:'Caption'}])).toBe('![Caption](file:stored)');
});
