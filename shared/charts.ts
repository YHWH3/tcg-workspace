import {parseDateOnly, startOfWeek, toDateOnlyInZone} from './dates';
import {aggregate, applyView, fieldValue, type ChartConfig, type FieldKey, type ViewConfig, type ViewCtx, type ViewRecord} from './views';

export const DEFAULT_CHART: ChartConfig = {chartType:'bar', xKey:'createdAt', xBucket:'week', yAgg:'count'};

const MAX_BUCKETS = 60;
const MAX_SERIES = 12;

export interface ChartPoint {
  x: string;
  value: number | null;
  records: string[];
  count: number;
  numericCount: number;
}

export interface ChartResult {
  buckets: string[];
  series: {key: string; points: ChartPoint[]}[];
  matched: number;
  skipped: number;
  partial: boolean;
}

export function isChartConfig(value: unknown): value is ChartConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<ChartConfig>;
  const key = (field: unknown) => typeof field === 'string' &&
    (/^(?:p_|rel_).+/.test(field) || ['title','status','assigneeId','dueDate','priority','createdAt','createdBy'].includes(field));
  return ['bar','stacked_bar','line'].includes(config.chartType ?? '') && key(config.xKey) &&
    (config.xBucket === undefined || ['day','week','month'].includes(config.xBucket)) &&
    (config.yAgg === 'count' || ((config.yAgg === 'sum' || config.yAgg === 'avg') && key(config.yKey))) &&
    (config.seriesKey === undefined || key(config.seriesKey));
}

function chartKey(row: ViewRecord, key: FieldKey, ctx: ViewCtx): string | null {
  const raw = fieldValue(row, key, ctx);
  // Match the existing database group-by behavior for list-valued fields.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    ? String(value)
    : null;
}

export function chartSeries(records: readonly ViewRecord[], config: ViewConfig & {chart: ChartConfig}, ctx: ViewCtx = {}): ChartResult {
  const {chart} = config;
  const rows = applyView(records, {...config, groupBy: null}, ctx).rows;
  const buckets = new Set<string>();
  const groups = new Map<string, Map<string, ViewRecord[]>>();
  let skipped = 0;

  for (const row of rows) {
    let x = chartKey(row, chart.xKey, ctx);
    if (chart.xBucket) {
      const date = chart.xKey === 'createdAt' && typeof row.createdAt === 'number'
        ? toDateOnlyInZone(row.createdAt, ctx.timeZone)
        : x;
      if (!date || !parseDateOnly(date)) x = null;
      else if (chart.xBucket === 'week') x = startOfWeek(date);
      else if (chart.xBucket === 'month') x = date.slice(0, 7);
      else x = date;
    }
    const series = chart.seriesKey ? chartKey(row, chart.seriesKey, ctx) : '';
    if (x === null || series === null) {
      skipped++;
      continue;
    }

    buckets.add(x);
    let points = groups.get(series);
    if (!points) groups.set(series, points = new Map());
    const contributing = points.get(x);
    if (contributing) contributing.push(row);
    else points.set(x, [row]);
  }

  const ordered = [...buckets];
  if (chart.xBucket) ordered.sort();
  const visibleBuckets = ordered.slice(0, MAX_BUCKETS);
  const visibleSeries = [...groups].slice(0, MAX_SERIES);
  return {
    buckets: visibleBuckets,
    series: visibleSeries.map(([key, points]) => ({
      key,
      points: visibleBuckets.map(x => {
        const {value, ids, count, numericCount} = aggregate(points.get(x) ?? [], {
          agg: chart.yAgg, fieldKey: chart.yKey, includeArchived: config.includeArchived,
        }, ctx);
        return {x, value: value !== null && Number.isFinite(value) ? value : null, records: ids, count, numericCount};
      }),
    })),
    matched: rows.length,
    skipped,
    partial: ordered.length > MAX_BUCKETS || groups.size > MAX_SERIES,
  };
}
