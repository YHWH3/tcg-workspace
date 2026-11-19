import {sanitizeReplacement} from '../src/core/assistant/applyPlan';
import {neutralize} from '../worker/websiteIngest';
import {expect,it} from 'vitest';
import {parseText,serialize,mentionTokens,renderPlain,textOffsetToDom,domToTextOffset} from '../src/core/mentions';
import {blocksToMarkdown,markdownToBlocks} from '../shared/markdown';
import {deriveEvents} from '../shared/events';
it('round-trips adjacent Space chips with Unicode and atomic caret boundaries',()=>{
 const text='👩🏽‍💻 @[group:space-core]@[user:bob] नमस्ते',nodes=parseText(text);expect(serialize(nodes)).toBe(text);expect(mentionTokens(text)).toEqual([{kind:'group',id:'space-core'},{kind:'user',id:'bob'}]);
 const start=text.indexOf('@['),length='@[group:space-core]'.length;
 expect(textOffsetToDom(nodes,start+1)).toEqual({index:1,char:0});expect(domToTextOffset(nodes,1,1)).toBe(start+length);
 expect(renderPlain(text,kind=>kind==='group'?'Core':undefined)).toBe('👩🏽‍💻 Core@someone नमस्ते');
});
it('keeps inaccessible group tokens intact in markdown rather than resolving unrelated names',()=>{
 const blocks=markdownToBlocks('Meet @[group:space-core] and @[group:hidden]');
 expect(blocksToMarkdown(blocks,{groupName:id=>id==='space-core'?'Core':undefined})).toBe('Meet @space(Core) and @[group:hidden]');
});
it('derives only newly introduced Space mentions and preserves direct event ordering',()=>{
 const change={id:'block',collection:'blocks',created:false,fields:['text'],before:{text:'@[group:old]'},after:{pageId:'page',text:'@[group:old] @[group:new] @[group:new] @[user:bob]'}};
 const events=deriveEvents([change]).filter(event=>event.kind==='mention.created');expect(events).toMatchObject([{to:'bob'},{groupId:'new',targetId:'page',targetType:'page'}]);expect(events).toHaveLength(2);
});

it('appends Space events after every historical event in a multi-record derivation',()=>{
 const changes=['first','second'].map(id=>({id,collection:'blocks',created:false,fields:['text'],before:{},after:{pageId:'page',text:'@[user:bob] @[group:space-core]'}}));
 expect(deriveEvents(changes).map(event=>[event.recordId,event.groupId??event.to])).toEqual([['first','bob'],['second','bob'],['first','space-core'],['second','space-core']]);
});

it('lets assistant replacements preserve sourced Space tokens but never invent them',()=>{
 expect(sanitizeReplacement('For @[group:allowed]','Hi @[group:allowed] @[group:invented]')).toBe('Hi @[group:allowed]');
 expect(sanitizeReplacement('Plain text','@[group:invented]')).toBe('');
});
it('keeps visitor-supplied Space syntax inert under the generic ingest neutralizer',()=>{
 const text=neutralize('Visitor @[group:space-core]');expect(mentionTokens(text)).toEqual([]);
 expect(deriveEvents([{id:'answer',collection:'blocks',created:true,fields:['text'],before:{},after:{pageId:'page',text}}]).filter(event=>event.kind==='mention.created')).toEqual([]);
});
