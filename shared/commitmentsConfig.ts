import {z} from 'zod';
const id=z.string().min(1).max(64),property=z.string().regex(/^p_[A-Za-z0-9_-]{1,64}$/),relation=z.string().regex(/^rel_[A-Za-z0-9_-]{1,64}$/);
/** Shared owning boundary for stored, browser and MCP configuration. */
export const commitmentsConfigSchema=z.object({databaseId:id,meetingId:id.nullish().transform(value=>value??undefined),dateKey:property.default('p_f_date'),actionsKey:relation.default('rel_f_actions'),decisionsKey:relation.default('rel_f_decisions'),decisionOwnerKey:property.default('p_f_decider'),days:z.number().int().min(1).max(3650).default(30),limit:z.number().int().min(1).max(20).default(10)}).refine(config=>config.actionsKey!==config.decisionsKey,'Choose distinct action and decision fields');
export type CommitmentsConfig=z.infer<typeof commitmentsConfigSchema>;
