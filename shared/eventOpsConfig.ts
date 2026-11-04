import {z} from 'zod';
const id=z.string().min(1).max(64),property=z.string().regex(/^p_[A-Za-z0-9_-]{1,64}$/),relation=z.string().regex(/^rel_[A-Za-z0-9_-]{1,64}$/);
/** Stored configuration, HTTP and MCP share one owning boundary. */
export const eventOpsConfigSchema=z.object({
 databaseId:id,eventId:id.nullish().transform(value=>value??undefined),
 startKey:property.default('p_f_start'),capacityKey:property.default('p_f_capacity'),
 facilitatorsKey:relation.default('rel_f_facilitators'),volunteersKey:relation.default('rel_f_volunteers'),participantsKey:relation.default('rel_f_participants'),
 upcomingOnly:z.boolean().default(true),limit:z.number().int().min(1).max(20).default(10),
}).refine(config=>new Set([config.facilitatorsKey,config.volunteersKey,config.participantsKey]).size===3,'Choose three distinct role fields');
export type EventOpsConfig=z.infer<typeof eventOpsConfigSchema>;
