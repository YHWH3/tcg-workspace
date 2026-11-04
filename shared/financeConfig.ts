import {z} from 'zod';
import {FILTER_OPERATORS,type FieldKey} from './views';
const id=z.string().min(1).max(64),key=z.string().regex(/^p_[A-Za-z0-9_-]{1,64}$/),field=z.string().regex(/^(title|status|assigneeId|dueDate|priority|createdAt|createdBy|p_[A-Za-z0-9_-]{1,64}|rel_[A-Za-z0-9_-]{1,64})$/).transform(v=>v as FieldKey);
/** One boundary for stored block configuration, HTTP and MCP. */
export const financeConfigSchema=z.object({
 mode:z.enum(['project','product']).default('project'),databaseId:id.nullish().transform(v=>v??undefined),recordId:id.nullish().transform(v=>v??undefined),
 budgetKey:key.default('p_f_budget'),amountKey:key.default('p_f_amount'),typeKey:key.default('p_f_type'),
 relationKey:z.string().regex(/^rel_[A-Za-z0-9_-]{1,64}$/).default('rel_f_transactions'),
 priceKey:key.default('p_f_price'),costKey:key.default('p_f_cost'),limit:z.number().int().min(1).max(20).default(10),
 filters:z.array(z.object({key:field,op:z.enum(FILTER_OPERATORS),value:z.unknown().optional()})).max(20).optional(),
}).refine(v=>!!v.databaseId||!!v.recordId,'Choose a database or record');
export type FinanceConfig=z.infer<typeof financeConfigSchema>;
