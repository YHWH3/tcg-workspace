import {z} from 'zod';
import {FILTER_OPERATORS,type FieldKey} from './views';
import {fieldsOf} from './fields';
const id=z.string().min(1).max(64),custom=z.string().regex(/^p_[A-Za-z0-9_-]{1,64}$/);
const field=z.string().regex(/^(title|status|assigneeId|dueDate|priority|createdAt|createdBy|p_[A-Za-z0-9_-]{1,64}|rel_[A-Za-z0-9_-]{1,64})$/).transform(v=>v as FieldKey);
/** Stored block configuration and HTTP input share one owning boundary. */
export const projectHealthConfigSchema=z.object({
 databaseId:id.nullish().transform(v=>v??undefined),projectId:id.nullish().transform(v=>v??undefined),
 ownerKey:z.union([z.literal('assigneeId'),custom]).default('p_f_owner'),
 startKey:z.union([z.literal('dueDate'),custom]).default('p_f_start'),
 endKey:z.union([z.literal('dueDate'),custom]).default('p_f_end'),
 staleDays:z.number().int().min(1).max(365).default(14),limit:z.number().int().min(1).max(20).default(10),
 filters:z.array(z.object({key:field,op:z.enum(FILTER_OPERATORS),value:z.unknown().optional()})).max(20).optional(),
}).refine(v=>!!v.databaseId||!!v.projectId,'Choose a database or project');
export type ProjectHealthConfig=z.infer<typeof projectHealthConfigSchema>;

/** Schema drift makes a configured observation incomplete, rather than a
 * trustworthy absence of values. Also reused before client edits. */
export function projectHealthFieldsAvailable(board:Record<string,unknown>,config:ProjectHealthConfig){
 const fields=fieldsOf(board);
 return config.startKey!==config.endKey&&(config.ownerKey==='assigneeId'||fields.some(f=>`p_${f.id}`===config.ownerKey&&f.type==='person'))&&[config.startKey,config.endKey].every(key=>key==='dueDate'||fields.some(f=>`p_${f.id}`===key&&f.type==='date'));
}
