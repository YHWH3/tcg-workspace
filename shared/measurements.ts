import type {FieldLogEntry} from './fieldSessions';
export interface MeasurementSeries {
 unit:string|null;units:string[];points:{date:string;value:number;recordId:string}[];
 omitted:{recordId:string;reason:'date'|'unit'}[];excludedByUnit:number;partial:boolean;error?:'mixed_units';
}
/** Explicit unit selection is a filter, never a conversion. Without a
 * selection a mixed-unit source is refused, including on an empty chart. */
export function measurementSeries(fieldLogs:readonly FieldLogEntry[],options:{experimentId?:string;placeId?:string;unit?:string}):MeasurementSeries{
 const logs=fieldLogs.filter(r=>(!options.experimentId||r.experiments.includes(options.experimentId))&&(!options.placeId||r.places.includes(options.placeId))).filter(r=>r.measurement!==null);
 const units=[...new Set(logs.map(r=>r.unit.trim().toLowerCase()).filter(Boolean))].sort(),selected=options.unit?.trim().toLowerCase()||null,unit=selected??(units.length===1?units[0]:null);
 if(!selected&&units.length>1)return {unit:null,units,points:[],omitted:[],excludedByUnit:0,partial:true,error:'mixed_units'};
 const points:MeasurementSeries['points']=[],omitted:MeasurementSeries['omitted']=[];let excludedByUnit=0;
 for(const log of logs){
  const normalized=log.unit.trim().toLowerCase();
  if(!normalized){omitted.push({recordId:log.id,reason:'unit'});continue;}
  if(selected&&normalized!==selected){excludedByUnit++;continue;}
  if(!log.date){omitted.push({recordId:log.id,reason:'date'});continue;}
  points.push({date:log.date,value:log.measurement!,recordId:log.id});
 }
 points.sort((a,b)=>a.date!==b.date?(a.date<b.date?-1:1):a.recordId<b.recordId?-1:a.recordId>b.recordId?1:0);
 return {unit,units,points,omitted,excludedByUnit,partial:omitted.length>0};
}
