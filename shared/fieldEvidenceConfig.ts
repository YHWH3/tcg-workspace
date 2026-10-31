import {z} from 'zod';
const id=z.string().min(1).max(64),key=z.string().regex(/^p_[A-Za-z0-9_-]{1,64}$/),relation=z.string().regex(/^rel_[A-Za-z0-9_-]{1,64}$/);
/** Stored configuration, HTTP and MCP share one boundary. */
export const fieldEvidenceConfigSchema=z.object({
 databaseId:id,dateKey:key.default('p_f_date'),measurementKey:key.default('p_f_measurement'),unitKey:key.default('p_f_unit'),observationKey:key.default('p_f_observation'),photoKey:key.default('p_f_photos'),
 placeKey:relation.default('rel_f_place'),experimentKey:relation.default('rel_f_experiment'),projectKey:relation.default('rel_f_project'),
 experimentId:id.nullish().transform(v=>v??undefined),placeId:id.nullish().transform(v=>v??undefined),unit:z.string().max(100).default(''),limit:z.number().int().min(1).max(50).default(10),missingOnly:z.boolean().default(false),
});
export type FieldEvidenceConfig=z.infer<typeof fieldEvidenceConfigSchema>;
/** Capture writes its planned count before attaching bytes. This is intent,
 * never proof of successful upload. Historical records have no provenance. */
export const captureEvidenceSchema=z.object({v:z.literal(1),photoCount:z.number().int().nonnegative()});
