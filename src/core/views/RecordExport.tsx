import { useMemo } from 'react';
import { Download, Printer } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Dialog, Button } from '../ui';
import { db } from '../db';
import { fieldsOf } from '../../../shared/fields';
import { recordToMarkdown } from '../pageExport';
import type { BoardRow, TaskRow } from '../../modules/boards/api';
import { useUsers } from '../users';

export function RecordExportDialog({ record, board, onClose }: { record: TaskRow; board: BoardRow; onClose: () => void }) {
  const blocks = useLiveQuery(() => db.blocks.where('pageId').equals(record.id).toArray(), [record.id], []) ?? [];
  const users = useUsers();
  const markdown = useMemo(() => recordToMarkdown(record, fieldsOf(board), blocks.filter((block) => !block.deleted) as never[], { userName: (id) => users.find((user) => user.id === id)?.name }), [blocks, board, record, users]);
  const filename = `${String(record.title ?? 'record').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'record'}.md`;
  const download = () => { const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); };
  return <Dialog title="Export record" onClose={onClose}><div className="space-y-3"><pre aria-label="Markdown preview" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-950">{markdown}</pre><div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={download}><Download size={14} /> Download Markdown</Button><Button variant="outline" onClick={() => window.print()}><Printer size={14} /> Print / PDF</Button></div></div></Dialog>;
}
