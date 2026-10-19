import {Hono} from 'hono';
import {requireAuth,type Env,type AuthUser} from './auth';
import {EMBEDDING_MODEL} from './aiProvider';
import {CLASSIFY_MODEL} from './aiClassification';
export const aiConfigApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();aiConfigApi.use('*',requireAuth);
aiConfigApi.get('/',async c=>{
 const u=c.get('user');const admin=await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND disabled_at IS NULL AND COALESCE(workspace_role,role) IN('owner','admin')").bind(u.id).first();
 const configured=c.env.AI_PROVIDER==='workers-ai'&&Number(c.env.AI_DAILY_UNITS)>0;
 const usage=admin?(await c.env.DB.prepare('SELECT kind,units FROM ai_usage WHERE day=?').bind(new Date().toISOString().slice(0,10)).all()).results:undefined;
 return c.json({provider:configured?'workers-ai':'none',semantic:configured?'configured':'disabled',classification:configured&&c.env.AI_CLASSIFICATION==='1'?'configured':'disabled',digest:'deterministic',embeddingModel:configured?EMBEDDING_MODEL:null,classificationModel:configured?CLASSIFY_MODEL:null,dailyBudget:admin?Number(c.env.AI_DAILY_UNITS??0):undefined,usage,unitDefinition:'Conservative input UTF-8 bytes plus reserved output tokens; not billing units',configuration:'Operator environment settings; no provider is enabled by using this screen',realProviderVerified:false});
});
