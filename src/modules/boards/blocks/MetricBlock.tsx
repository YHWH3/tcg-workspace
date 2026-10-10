/**
 * `metric` dashboard block (§3): big number via shared `aggregate()` — count /
 * sum / avg over the filtered record set — with label and `format`
 * ('currency' → Intl USD by default). Click drills into `RecordListSheet`
 * with the exact `ids` the number aggregates. Missing/loading/archived/
 * no-data states are distinct and never crash.
 */
import { useState } from 'react';
import { Hash } from 'lucide-react';
import { authStore } from '../../../core/auth';
import type { LocalRow } from '../../../core/db';
import { useLinks } from '../../../core/links';
import { useStore } from '../../../core/store';
import { Field, Select } from '../../../core/ui';
import { cn, todayISO } from '../../../core/utils';
import { availableFieldKeys, fieldKeyLabel, viewCtx } from '../../../core/records';
import { boardTasks } from '../api';
import { registerBlockType, type MediaBlockProps } from '../../pages/blocks/registry';
import { BlockNotice, DashBlock, DatabasePicker, DraftInput, HeadingField, RecordListSheet, pickableBoards, saveBlockCfg, str, useBoardsQuery, useTasksQuery } from './shared';
import { isArchived } from '../../../../shared/archive';
import { aggregate as aggregateShared } from '../../../../shared/views';
import type { FieldKey, Filter } from '../../../../shared/views';

const AGGS: { id: 'count' | 'sum' | 'avg'; label: string }[] = [
  { id: 'count', label: 'Count' },
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const plain = new Intl.NumberFormat('en-US');

function MetricBlockInner({ block }: { block: LocalRow }) {
  const boards = useBoardsQuery();
  const tasks = useTasksQuery();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const [drill, setDrill] = useState(false);

  const databaseId = str(block.databaseId);
  const board = boards?.find((b) => b.id === databaseId);

  if (!databaseId) return <BlockNotice>Pick a database in Configure.</BlockNotice>;
  if (boards === undefined || tasks === undefined) return <BlockNotice tone="loading">Loading…</BlockNotice>;
  if (!board) return <BlockNotice>Database missing — pick another in Configure.</BlockNotice>;
  if (isArchived(board)) return <BlockNotice>Source database is archived.</BlockNotice>;

  const ctx = viewCtx(board, tasks, links, me, todayISO());
  const records = boardTasks(tasks, board.id).filter((t) => !t.parentId);
  const agg = (str(block.agg) as 'count' | 'sum' | 'avg' | undefined) ?? 'count';
  const fieldKey = str(block.fieldKey) as FieldKey | undefined;
  const filters = Array.isArray(block.filters) ? (block.filters as Filter[]) : undefined;
  const result = aggregateShared(records, { filters, agg, fieldKey }, ctx);

  const value =
    result.value === null || result.value === undefined
      ? null
      : str(block.format) === 'currency'
        ? usd.format(result.value)
        : plain.format(result.value);
  const label = str(block.label) ?? (agg === 'count' ? 'Records' : agg === 'sum' ? `Sum${fieldKey ? ` · ${fieldKeyLabel(board, fieldKey)}` : ''}` : `Average${fieldKey ? ` · ${fieldKeyLabel(board, fieldKey)}` : ''}`);

  if (result.ids.length === 0 && result.value === null) {
    return <BlockNotice>No data — adjust the filters or field.</BlockNotice>;
  }

  return (
    <>
      <button
        className="flex w-full flex-col items-start gap-0.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-neutral-50 focus-visible:bg-neutral-50 dark:hover:bg-neutral-800/60 dark:focus-visible:bg-neutral-800/60"
        onClick={() => setDrill(true)}
        aria-label={`${label}: ${value ?? 'no data'} — show records`}
      >
        <span className={cn('text-3xl font-semibold tracking-tight tabular-nums', value === null && 'text-neutral-300 dark:text-neutral-600')}>{value ?? '—'}</span>
        <span className="text-xs text-neutral-400">{label}</span>
        {agg !== 'count' && result.numericCount < result.count && <span className="text-[10px] text-neutral-400">from {result.numericCount} of {result.count} rows</span>}
      </button>
      {drill && <RecordListSheet ids={result.ids} board={board} onClose={() => setDrill(false)} />}
    </>
  );
}

function MetricBlock({ block }: MediaBlockProps) {
  const boards = useBoardsQuery();
  const databaseId = str(block.databaseId) ?? '';
  const board = boards?.find((b) => b.id === databaseId);
  const agg = (str(block.agg) as 'count' | 'sum' | 'avg' | undefined) ?? 'count';
  const keys = board ? availableFieldKeys(board) : [];
  return (
    <DashBlock
      block={block}
      icon={Hash}
      label="Metric"
      config={
        <>
          <HeadingField value={str(block.heading)} onChange={(v) => saveBlockCfg(block, { heading: v ?? null })} />
          <DatabasePicker value={databaseId} boards={pickableBoards(boards)} onChange={(id) => saveBlockCfg(block, { databaseId: id })} />
          <Field label="Aggregate">
            <Select value={agg} onChange={(e) => saveBlockCfg(block, { agg: e.target.value })} aria-label="Aggregate">
              {AGGS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          {agg !== 'count' && (
            <Field label="Field">
              <Select value={str(block.fieldKey) ?? ''} onChange={(e) => saveBlockCfg(block, { fieldKey: e.target.value || null })} aria-label="Numeric field">
                <option value="">Pick a field…</option>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {board ? fieldKeyLabel(board, k) : k}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Label">
            <DraftInput
              value={str(block.label) ?? ''}
              placeholder={agg === 'count' ? 'Records' : 'Metric label'}
              onCommit={(v) => saveBlockCfg(block, { label: v || null })}
              aria-label="Metric label"
            />
          </Field>
          <Field label="Format">
            <Select value={str(block.format) ?? 'number'} onChange={(e) => saveBlockCfg(block, { format: e.target.value === 'currency' ? 'currency' : null })} aria-label="Number format">
              <option value="number">Number</option>
              <option value="currency">Currency (USD)</option>
            </Select>
          </Field>
        </>
      }
    >
      {() => <MetricBlockInner block={block} />}
    </DashBlock>
  );
}

registerBlockType('metric', 'Metric', MetricBlock);
export default MetricBlock;
