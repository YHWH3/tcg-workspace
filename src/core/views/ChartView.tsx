import {useId, useMemo, useState} from 'react';
import {Link} from 'react-router';
import {chartSeries, DEFAULT_CHART, isChartConfig, type ChartPoint} from '../../../shared/charts';
import {fieldsOf, formatFieldValue} from '../../../shared/fields';
import {recordHref} from '../../../shared/recordRoutes';
import type {ChartConfig, FieldKey, ViewCtx, ViewRecord, ViewRow} from '../../../shared/views';
import type {BoardRow} from '../../modules/boards/api';
import {availableFieldKeys, fieldKeyLabel, fieldKeyOf, stagesOf} from '../records';
import {Button, Dialog, Field, Select, Sheet} from '../ui';
import {useIsMobile} from '../mobile';
import {useWorkspaceLocale} from '../workspaceLocale';

export function ChartSettings({board, initial, onSave, onClose}: {
  board: BoardRow; initial: ChartConfig; onSave: (chart: ChartConfig) => void; onClose: () => void;
}) {
  const [chart, setChart] = useState(initial);
  const mobile = useIsMobile();
  const defs = fieldsOf(board);
  const axes = [...new Set<FieldKey>(['createdAt', 'dueDate', ...availableFieldKeys(board)])];
  const numeric = defs.filter(field => field.type === 'number').map(fieldKeyOf);
  const isDate = (key: FieldKey) => key === 'createdAt' || key === 'dueDate' || defs.some(field => field.type === 'date' && fieldKeyOf(field) === key);
  const options = (keys: FieldKey[]) => keys.map(key => <option key={key} value={key}>{fieldKeyLabel(board,key)}</option>);
  const valid = axes.includes(chart.xKey) && (chart.yAgg === 'count' || (chart.yKey && numeric.includes(chart.yKey)));
  const form = (
      <form className="grid min-w-0 gap-3" onSubmit={event => {
        event.preventDefault();
        if (valid) onSave(chart);
      }}>
        <Field label="Chart type">
          <Select aria-label="Chart type" value={chart.chartType} onChange={event => setChart({...chart,chartType:event.target.value as ChartConfig['chartType']})}>
            <option value="bar">Bar</option>
            <option value="stacked_bar">Stacked bar</option>
            <option value="line">Line</option>
          </Select>
        </Field>
        <Field label="Horizontal field">
          <Select aria-label="Horizontal field" value={chart.xKey} onChange={event => {
            const xKey = event.target.value as FieldKey;
            setChart({...chart,xKey,xBucket:isDate(xKey) ? chart.xBucket ?? 'day' : undefined});
          }}>
            {options(axes)}
          </Select>
        </Field>
        {isDate(chart.xKey) && (
          <Field label="Date interval">
            <Select aria-label="Date interval" value={chart.xBucket ?? 'day'} onChange={event => setChart({...chart,xBucket:event.target.value as ChartConfig['xBucket']})}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </Select>
          </Field>
        )}
        <Field label="Summarize by">
          <Select aria-label="Summarize by" value={chart.yAgg} onChange={event => {
            const yAgg = event.target.value as ChartConfig['yAgg'];
            setChart({...chart,yAgg,yKey:yAgg === 'count' ? undefined : chart.yKey ?? numeric[0]});
          }}>
            <option value="count">Count</option>
            <option value="sum" disabled={!numeric.length}>Sum</option>
            <option value="avg" disabled={!numeric.length}>Average</option>
          </Select>
        </Field>
        {chart.yAgg !== 'count' && (
          <Field label="Numeric field">
            <Select aria-label="Numeric field" value={chart.yKey ?? ''} onChange={event => setChart({...chart,yKey:event.target.value as FieldKey})}>
              <option value="" disabled>Choose a field</option>
              {options(numeric)}
            </Select>
          </Field>
        )}
        <Field label="Split by">
          <Select aria-label="Split by" value={chart.seriesKey ?? ''} onChange={event => setChart({...chart,seriesKey:(event.target.value || undefined) as FieldKey | undefined})}>
            <option value="">No split</option>
            {options(axes.filter(key => key !== 'createdAt'))}
          </Select>
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid}>Save chart</Button>
        </div>
      </form>
  );
  return mobile
    ? <Sheet label="Chart settings" side="full" onClose={onClose}>{form}</Sheet>
    : <Dialog title="Chart settings" onClose={onClose}>{form}</Dialog>;
}

const pointColors = [
  'text-blue-700 dark:text-blue-300', 'text-emerald-700 dark:text-emerald-300',
  'text-purple-700 dark:text-purple-300', 'text-orange-800 dark:text-orange-300',
  'text-teal-800 dark:text-teal-300', 'text-rose-700 dark:text-rose-300',
];
const axisHeight = 234;
const left = 52;
const top = 16;

export function ChartView({board, view, records, context, onConfig}: {
  board: BoardRow; view: ViewRow; records: readonly ViewRecord[]; context: ViewCtx; onConfig?: (chart: ChartConfig) => void;
}) {
  const titleId = useId(), descriptionId = useId();
  const [table, setTable] = useState(false);
  const [settings, setSettings] = useState(false);
  const [selection, setSelection] = useState<{series: string; x: string} | null>(null);
  const [recordLimit, setRecordLimit] = useState(25);
  const locale = useWorkspaceLocale();
  const invalidChart = view.config.chart !== undefined && !isChartConfig(view.config.chart);
  const chart = isChartConfig(view.config.chart) ? view.config.chart : DEFAULT_CHART;
  const data = useMemo(() => chartSeries(invalidChart ? [] : records, {...view.config, chart}, context), [invalidChart, records, view.config, chart, context]);
  const field = chart.yAgg === 'count' ? undefined : fieldsOf(board).find(def => fieldKeyOf(def) === chart.yKey);
  const valueLabel = (value: number | null) => {
    if (value === null) return 'No value';
    return formatFieldValue(field ?? {id:'value',name:'Value',type:'number'},value,{workspaceCurrency:locale.settings?.currency}) ?? 'No value';
  };
  const label = (key: FieldKey | undefined, value: string) => {
    if (!key) return '';
    if (!value) return 'No value';
    if (key === 'status') return stagesOf(board).find(stage => stage.id === value)?.name ?? value;
    return fieldsOf(board).find(def => fieldKeyOf(def) === key)?.options?.find(option => option.id === value)?.name ?? value;
  };
  const select = (series: string, point: ChartPoint) => {
    setRecordLimit(25);
    setSelection({series, x:point.x});
  };
  const pointLabel = (series: string, point: ChartPoint) =>
    [label(chart.xKey,point.x), label(chart.seriesKey,series), valueLabel(point.value), `${point.count} ${point.count === 1 ? 'record' : 'records'}`].filter(Boolean).join(', ');
  const visibleSelection = selection && data.series.find(series => series.key === selection.series)?.points.find(point => point.x === selection.x);
  const recordsById = new Map(records.map(row => [String(row.id), row]));
  const scale = Math.max(1, ...data.series.flatMap(series => series.points.map(point => Math.abs(point.value ?? 0))));
  const stacked = chart.chartType === 'stacked_bar';
  const positive = data.buckets.map((_key, index) => {
    const values = data.series.map(series => Math.max(0,(series.points[index].value ?? 0)/scale));
    return stacked ? values.reduce((a,b) => a+b,0) : Math.max(0,...values);
  });
  const negative = data.buckets.map((_key, index) => {
    const values = data.series.map(series => Math.min(0,(series.points[index].value ?? 0)/scale));
    return stacked ? values.reduce((a,b) => a+b,0) : Math.min(0,...values);
  });
  const upper = Math.max(0,...positive);
  const lower = Math.min(0,...negative);
  const y = (value: number) => top + (upper-value)/(upper-lower || 1)*(axisHeight-top);
  const spacing = chart.chartType === 'bar' ? Math.max(62, data.series.length*27+12) : 68;
  const width = Math.max(310,left+data.buckets.length*spacing+14);
  const midpoint = (index: number) => left+(index+0.5)*spacing;

  return (
    <section className="min-w-0 space-y-3 p-3 sm:p-4" aria-label={view.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{data.matched} matching {data.matched === 1 ? 'record' : 'records'}</p>
        <div className="flex flex-wrap gap-2">
          {onConfig && <Button onClick={() => setSettings(true)}>Chart settings</Button>}
          <Button onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show as table'}</Button>
        </div>
      </div>
      {data.partial && <p role="status" className="text-sm">The chart shows up to 60 groups and 12 series. Filter the view to narrow the results.</p>}
      {data.skipped > 0 && <p className="text-sm">{data.skipped} {data.skipped === 1 ? 'record has' : 'records have'} no usable horizontal or series value.</p>}
      {invalidChart ? <p className="text-sm">Choose the chart fields in Chart settings.</p> : data.buckets.length === 0
        ? <p className="py-6 text-sm text-neutral-700 dark:text-neutral-300">No records to chart.</p>
        : table ? (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <caption className="sr-only">{view.name} data</caption>
              <thead><tr>
                <th scope="col" className="p-2 text-start">{fieldKeyLabel(board,chart.xKey)}</th>
                {chart.seriesKey && <th scope="col" className="p-2 text-start">{fieldKeyLabel(board,chart.seriesKey)}</th>}
                <th scope="col" className="p-2 text-start">Value</th>
                <th scope="col" className="p-2 text-start">Records</th>
              </tr></thead>
              <tbody>{data.series.flatMap(series => series.points.map(point => (
                <tr key={JSON.stringify([series.key,point.x])} className="border-t border-neutral-200 dark:border-neutral-700">
                  <th scope="row" className="p-2 text-start font-medium">{label(chart.xKey,point.x)}</th>
                  {chart.seriesKey && <td className="p-2">{label(chart.seriesKey,series.key)}</td>}
                  <td className="p-2">{valueLabel(point.value)}</td>
                  <td className="p-2">{point.count > 0
                    ? <Button size="sm" aria-label={`Show records for ${pointLabel(series.key,point)}`} onClick={() => select(series.key,point)}>{point.count}</Button>
                    : 0}</td>
                </tr>
              )))}</tbody>
            </table>
          </div>
        ) : (
          <>
            {chart.seriesKey && <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Series">
              {data.series.map((series,index) => <li key={series.key} className={pointColors[index%pointColors.length]}>{index+1}. {label(chart.seriesKey,series.key)}</li>)}
            </ul>}
            <div className="overflow-x-auto pb-2" role="region" aria-label="Chart plot" tabIndex={0}>
              <svg role="group" aria-labelledby={titleId} aria-describedby={descriptionId} width={width} height={276} viewBox={`0 0 ${width} 276`}>
                <title id={titleId}>{view.name}</title>
                <desc id={descriptionId}>Select a bar or point to open its source records. The table shows the same values as text.</desc>
                <line x1={left} x2={width-10} y1={y(0)} y2={y(0)} stroke="currentColor" opacity={0.75}/>
                {[...new Set([upper,0,lower])].map(value => (
                  <text key={value} x={left-7} y={y(value)} dy="0.35em" textAnchor="end" className="fill-current text-xs">
                    {new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value*scale)}
                  </text>
                ))}
                {data.buckets.map((bucket,index) => {
                  const text = label(chart.xKey,bucket);
                  const short = Array.from(text);
                  return <text key={bucket} x={midpoint(index)} y={261} textAnchor="middle" className="fill-current text-xs">
                    {short.length > 10 ? short.slice(0,9).join('')+'…' : text}
                  </text>;
                })}
                {data.series.map((series,seriesIndex) => {
                  const color = pointColors[seriesIndex%pointColors.length];
                  return <g key={series.key} className={color}>
                    {chart.chartType === 'line' && series.points.slice(1).map((point,index) => {
                      const previous = series.points[index];
                      return previous.count && point.count && previous.value !== null && point.value !== null
                        ? <line key={point.x} x1={midpoint(index)} x2={midpoint(index+1)}
                            y1={y(previous.value/scale)} y2={y(point.value/scale)} stroke="currentColor"
                            strokeDasharray={seriesIndex % 2 ? '5 3' : undefined} strokeWidth={2}/>
                        : null;
                    })}
                    {series.points.map((point,index) => {
                      if (!point.count || point.value === null) return null;
                      const value = point.value / scale;
                      const mid = midpoint(index);
                      const stack = stacked ? data.series.slice(0,seriesIndex).reduce((sum,other) => {
                        const number = (other.points[index].value ?? 0)/scale;
                        return (number >= 0) === (value >= 0) ? sum+number : sum;
                      },0) : 0;
                      const barWidth = stacked ? 36 : 21;
                      const x = mid - barWidth/2 + (stacked ? 0 : (seriesIndex-(data.series.length-1)/2)*27);
                      const tooltip = pointLabel(series.key,point);
                      const pointY = y(stack+value);
                      return <g key={point.x} role="button" tabIndex={0} aria-label={tooltip}
                        className="cursor-pointer focus-visible:outline-2 focus-visible:outline-current"
                        onClick={() => select(series.key,point)} onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); select(series.key,point);}
                        }}>
                        <title>{tooltip}</title>
                        {chart.chartType === 'line' ? <>
                          <circle cx={mid} cy={pointY} r={12} fill="transparent"/>
                          <circle cx={mid} cy={pointY} r={5} fill="currentColor"/>
                        </> : <rect x={x} y={Math.min(y(stack),pointY)} width={barWidth} height={Math.max(3,Math.abs(pointY-y(stack)))} fill="currentColor" rx={2}/>}
                        {chart.seriesKey && <text x={chart.chartType === 'line' ? mid : x+barWidth/2} y={pointY-5} textAnchor="middle" className="fill-current text-[10px]">{seriesIndex+1}</text>}
                      </g>;
                    })}
                  </g>;
                })}
              </svg>
            </div>
          </>
        )}
      {settings && onConfig && <ChartSettings board={board} initial={chart} onClose={() => setSettings(false)} onSave={next => {
        onConfig(next);
        setSettings(false);
      }}/>}
      {visibleSelection && selection && (
        <Dialog title="Chart records" onClose={() => setSelection(null)}>
          <p className="mb-3 break-words text-sm">{pointLabel(selection.series,visibleSelection)}</p>
          <ul className="space-y-1">
            {visibleSelection.records.slice(0,recordLimit).map(id => <li key={id}>
              <Link className="inline-flex min-h-8 items-center break-all text-blue-700 underline dark:text-blue-300"
                to={recordHref(board.id,view.id,id)} onClick={() => setSelection(null)}>
                {String(recordsById.get(id)?.title ?? 'Untitled')}
              </Link>
            </li>)}
          </ul>
          {visibleSelection.records.length > recordLimit &&
            <Button className="mt-2" onClick={() => setRecordLimit(recordLimit+25)}>Show more records</Button>}
        </Dialog>
      )}
    </section>
  );
}
