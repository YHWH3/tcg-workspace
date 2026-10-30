import type {MeasurementSeries} from './measurements';
/** Input is the normalized finite/date-only series. Scale before subtracting
 * extreme signed values, so a valid ±1e308 series still has finite geometry. */
export function measurementLayout(points:MeasurementSeries['points']){
 const width=640,height=240,padding=24;
 if(!points.length)return {width,height,points:[],path:'',min:null,max:null};
 const values=points.map(p=>p.value),min=Math.min(...values),max=Math.max(...values),magnitude=Math.max(Math.abs(min),Math.abs(max),1),low=min/magnitude,high=max/magnitude;
 const times=points.map(p=>{const [y,m,d]=p.date.split('-').map(Number),date=new Date(0);date.setUTCFullYear(y,m-1,d);date.setUTCHours(0,0,0,0);return date.getTime();}),start=Math.min(...times),end=Math.max(...times);
 const positions=points.map((p,i)=>({...p,x:start===end?width/2:padding+(times[i]-start)/(end-start)*(width-2*padding),y:low===high?height/2:height-padding-(p.value/magnitude-low)/(high-low)*(height-2*padding)}));
 return {width,height,points:positions,path:positions.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' '),min,max};
}
