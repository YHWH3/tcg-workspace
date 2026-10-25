import {useWorkspaceLocale} from '../../../core/workspaceLocale';
/**
 * `view` dashboard block (§3): embeds the REAL view component for a database —
 * no grid re-implementation. `databaseId` picks the database; `viewId` pins a
 * stored view, else `inline` ViewConfig merges over the database's default
 * view; `limit` slices the filtered rows; `heading` renders a block title.
 */
import { useMemo } from 'react';
import { LayoutGrid } from 'lucide-react';
import { authStore } from '../../../core/auth';
import type { LocalRow } from '../../../core/db';
import { useLinks } from '../../../core/links';
import { useStore } from '../../../core/store';
import { Field, Select } from '../../../core/ui';
import { todayISO } from '../../../core/utils';
import { applyView, resolveView, stagesOf, useViews, viewCtx, type ViewRow } from '../../../core/records';
import { Board } from '../Board';
import { boardTasks, type BoardRow, type TaskRow } from '../api';
import { GroupBoard } from '../../../core/views/GroupBoard';
import { ListView } from '../../../core/views/ListView';
import { GalleryView } from '../../../core/views/GalleryView';
import { TableView } from '../../../core/views/TableView';
import { CalendarView } from '../views/CalendarView';
import { TimelineView } from '../views/TimelineView';
import { registerBlockType, type MediaBlockProps } from '../../pages/blocks/registry';
import { BlockNotice, DashBlock, DatabasePicker, HeadingField, LimitField, blockInline, pickableBoards, saveBlockCfg, str, num, useBoardsQuery, useTasksQuery } from './shared';
import { isArchived } from '../../../../shared/archive';

function renderBlockView(board: BoardRow, view: ViewRow, records: TaskRow[]) {
  const type = view.type ?? 'table';
  const cols = stagesOf(board);
  if (type === 'board') {
    const groupBy = view.config?.groupBy;
    if (!groupBy || groupBy === 'status') {
      if (!cols.length) return <ListView board={board} view={{ ...view, type: 'list' }} records={records} />;
      return <Board board={board} tasks={records} />;
    }
    return <GroupBoard board={board} view={view} records={records} />;
  }
  if (type === 'list') return <ListView board={board} view={view} records={records} />;
  if (type === 'gallery') return <GalleryView board={board} view={view} records={records} />;
  if (type === 'calendar') return <CalendarView board={board} view={view} records={records} />;
  if (type === 'timeline') return <TimelineView board={board} view={view} records={records} />;
  return <TableView board={board} view={view} records={records} />;
}

function ViewBlockInner({ block }: { block: LocalRow }) {
  useWorkspaceLocale();
  const boards = useBoardsQuery();
  const tasks = useTasksQuery();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const databaseId = str(block.databaseId);
  const views = useViews(databaseId);
  const board = boards?.find((b) => b.id === databaseId);

  const view = useMemo((): ViewRow | undefined => {
    if (!board) return undefined;
    const pinned = block.viewId ? views.find((v) => v.id === block.viewId && !v.deleted) : undefined;
    const base = pinned ?? resolveView(board, views, undefined);
    const inline = blockInline(block);
    return inline ? { ...base, config: { ...base.config, ...inline } } : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, views, block.viewId, block.inline]);

  if (!databaseId) return <BlockNotice>Pick a database in Configure.</BlockNotice>;
  if (boards === undefined || tasks === undefined) return <BlockNotice tone="loading">Loading…</BlockNotice>;
  if (!board) return <BlockNotice>Database missing — pick another in Configure.</BlockNotice>;
  if (isArchived(board)) return <BlockNotice>Source database is archived.</BlockNotice>;
  if (!view) return <BlockNotice tone="loading">Loading…</BlockNotice>;

  const ctx = viewCtx(board, tasks, links, me, todayISO());
  const baseRows = boardTasks(tasks, board.id).filter((t) => !t.parentId);
  const limit = num(block.limit);
  const rows = applyView(baseRows, view.config, ctx).rows;
  const sliced = limit ? rows.slice(0, limit) : rows;

  return <div className="dashboard-view -mx-1">{renderBlockView(board, view, sliced)}</div>;
}

function ViewBlock({ block }: MediaBlockProps) {
  const boards = useBoardsQuery();
  const databaseId = str(block.databaseId) ?? '';
  const views = useViews(databaseId || undefined);
  const pickers = pickableBoards(boards);
  return (
    <DashBlock
      block={block}
      icon={LayoutGrid}
      label="View"
      config={
        <>
          <HeadingField value={str(block.heading)} onChange={(v) => saveBlockCfg(block, { heading: v ?? null })} />
          <DatabasePicker value={databaseId} boards={pickers} onChange={(id) => saveBlockCfg(block, { databaseId: id, viewId: null })} />
          <Field label="View">
            <Select value={str(block.viewId) ?? ''} onChange={(e) => saveBlockCfg(block, { viewId: e.target.value || null })} aria-label="Stored view">
              <option value="">Default view</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <LimitField value={num(block.limit)} onChange={(n) => saveBlockCfg(block, { limit: n ?? null })} />
        </>
      }
    >
      {() => <ViewBlockInner block={block} />}
    </DashBlock>
  );
}

registerBlockType('view', 'Database view', ViewBlock);
export default ViewBlock;
