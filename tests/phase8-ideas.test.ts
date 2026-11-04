import {it,expect} from 'vitest';
import {ideaHandoffs} from '../shared/ideaHandoff';
import {planConversion} from '../shared/conversion';
const boards=[{id:'ideas',templateDbKey:'ideas',columns:[{id:'converted'}],fields:[{id:'f_converted_project',type:'relation',relation:{target:'projects',primary:true}}]},{id:'projects',templateDbKey:'projects',columns:[],fields:[]}];
const rows=[{id:'idea',boardId:'ideas',title:'<script> is text'},{id:'project',boardId:'projects',title:'Project 👩🏽‍💻'}];
const link={id:'link',kind:'relation',fieldId:'f_converted_project',fromId:'idea',toId:'project'};
it('uses only the canonical currently available relation in both directions',()=>{
 expect(ideaHandoffs(rows[0],boards,rows,[link])).toEqual([{direction:'to_project',id:'project',databaseId:'projects',title:'Project 👩🏽‍💻'}]);
 expect(ideaHandoffs(rows[1],boards,rows,[link])).toEqual([{direction:'from_idea',id:'idea',databaseId:'ideas',title:'<script> is text'}]);
 for(const bad of [{...link,deleted:true},{...link,kind:'related'},{...link,fieldId:'other'}])expect(ideaHandoffs(rows[0],boards,rows,[bad])).toEqual([]);
 expect(ideaHandoffs(rows[0],boards,[rows[0],{...rows[1],deleted:true}],[link])).toEqual([]);
 expect(ideaHandoffs(rows[0],boards,[rows[0]],[link])).toEqual([]);
 expect(ideaHandoffs(rows[0],[boards[0],{...boards[1],archived:true}],rows,[link])).toEqual([]);
 expect(ideaHandoffs(rows[0],boards,[rows[0],{...rows[1],boardId:'elsewhere'}],[link])).toEqual([]);
 expect(ideaHandoffs({...rows[0],convertedFrom:'project'} as typeof rows[0],boards,rows,[])).toEqual([]);
 expect(ideaHandoffs(rows[0],boards,rows,[link,{...link,id:'duplicate'}])).toHaveLength(1);
});
it('writes a canonical deterministic relation and refuses a retargeted field',()=>{
 const plan=planConversion({src:rows[0],srcBoard:boards[0],destBoard:boards[1],sourceStage:'converted',sourceRelationFieldId:'f_converted_project'},{id:()=> 'new-project',now:1});
 expect(plan).not.toHaveProperty('error');if('error' in plan)return;
 expect(plan.ops.filter(o=>o.collection==='links').map(o=>o.patch.kind)).toEqual(['related','relation']);
 expect(planConversion({src:rows[0],srcBoard:boards[0],destBoard:{...boards[1],id:'wrong'},sourceRelationFieldId:'f_converted_project'},{id:()=> 'unused',now:1})).toHaveProperty('error');
});
