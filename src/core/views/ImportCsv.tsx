import { useMemo, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { AdaptiveDialog, Button, Field, Select } from '../ui';
import { authStore } from '../auth';
import { mutate, mutateMany } from '../sync/engine';
import { firstColumnId, useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { fieldsOf, FIELD_TYPES } from '../../../shared/fields';
import { parseCsv, toCsv, type ParsedCsv } from '../../../shared/csv';
import {
  autoMappings,
  planCsvImport,
  saveCsvImportJournal,
  type CsvColumnMapping,
  type CsvImportJournal,
  type CsvImportOptions,
  type CsvImportPlan,
} from '../csvImport';
import { workspaceTimeZone } from '../workspaceLocale';

type Step = 'file' | 'map' | 'options' | 'preview' | 'result';

export function ImportCsvDialog({ board, records, onClose }: { board: BoardRow; records: readonly TaskRow[]; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mappings, setMappings] = useState<CsvColumnMapping[]>([]);
  const [dateFormat, setDateFormat] = useState<CsvImportOptions['dateFormat']>(workspaceTimeZone().startsWith('Asia/') ? 'dd/mm/yyyy' : 'yyyy-mm-dd');
  const [unknownSelect, setUnknownSelect] = useState<CsvImportOptions['unknownSelect']>('add');
  const [updateKey, setUpdateKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: number } | null>(null);
  const allTasks = useTasks();

  const relationTargets = useMemo(() => {
    const out: Record<string, { id: string; title: string }[]> = {};
    for (const field of fieldsOf(board)) {
      if (field.type !== 'relation' || !field.relation || field.relation.target === 'pages') continue;
      out[field.id] = allTasks.filter((record) => !record.deleted && !record.archived && record.boardId === field.relation!.target).map((record) => ({ id: record.id, title: String(record.title ?? '') }));
    }
    return out;
  }, [allTasks, board]);

  const options: CsvImportOptions | null = parsed ? { board, parsed, mappings, records, dateFormat, updateKey: updateKey || undefined, unknownSelect, relationTargets } : null;
  const plan: CsvImportPlan | null = options ? planCsvImport(options) : null;
  const updateKeys = mappings.filter((mapping) => mapping.target === 'title' || mapping.target.startsWith('p_'));

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      const next = parseCsv(text);
      setFileName(file.name);
      setParsed(next);
      setMappings(autoMappings(next, board));
      setStep('map');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The CSV could not be read.');
    }
  };

  const updateMapping = (index: number, target: CsvColumnMapping['target']) => {
    setMappings((current) => current.map((mapping, i) => i === index ? { ...mapping, target } : mapping));
  };

  const downloadErrors = () => {
    if (!plan?.errors.length) return;
    const csv = toCsv([['Row', 'Reason'], ...plan.errors.map((item) => [item.row, item.reason])]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName.replace(/\.csv$/i, '') || 'import'}-errors.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const importRows = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    try {
      const now = Date.now();
      const me = authStore.get().user?.id ?? null;
      const status = firstColumnId(board);
      const writes = plan.writes.map((write, index) => {
        const patch = write.created
          ? { boardId: board.id, status, order: `import-${String(index).padStart(8, '0')}`, createdBy: me, createdAt: now, ...write.patch }
          : write.patch;
        return { ...write, patch, after: patch };
      });
      const journal: CsvImportJournal = {
        id: crypto.randomUUID(),
        databaseId: board.id,
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        created: writes.filter((write) => write.created).map((write) => ({ id: write.id, after: write.after })),
        updates: writes.filter((write) => !write.created).map((write) => ({ id: write.id, before: write.before ?? {}, after: write.after })),
        linkIds: plan.links.map((link) => link.id),
      };
      if (JSON.stringify(plan.fields) !== JSON.stringify(fieldsOf(board))) await mutate('boards', board.id, { fields: plan.fields });
      await saveCsvImportJournal(journal);
      for (let i = 0; i < writes.length; i += 200) {
        await mutateManyChunk('tasks', writes.slice(i, i + 200).map((write) => ({ id: write.id, patch: write.patch })));
        setProgress(Math.round(((i + Math.min(200, writes.length - i)) / Math.max(1, writes.length)) * 100));
      }
      if (plan.links.length) {
        for (let i = 0; i < plan.links.length; i += 200) {
          await mutateManyChunk('links', plan.links.slice(i, i + 200));
        }
      }
      setResult({ created: plan.creates, updated: plan.updates, skipped: plan.skips, errors: plan.errors.length });
      setStep('result');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdaptiveDialog title="Import CSV" onClose={onClose}>
      <div className="space-y-4">
        <nav aria-label="CSV import steps" className="flex flex-wrap gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {(['file', 'map', 'options', 'preview'] as Step[]).map((name, index) => <span key={name} className={step === name ? 'font-semibold text-neutral-900 dark:text-white' : undefined}>{index + 1}. {name[0].toUpperCase() + name.slice(1)}</span>)}
        </nav>
        {step === 'file' && <section className="space-y-3"><p className="text-sm text-neutral-600 dark:text-neutral-300">Choose a CSV up to 5 MB and 5,000 rows. The file is read on this device.</p><input ref={inputRef} type="file" accept=".csv,text/csv,text/tab-separated-values" onChange={(event) => { void selectFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /><p className="text-xs text-neutral-500 dark:text-neutral-400">Delimiter detection supports comma, semicolon and tab files.</p></section>}
        {step === 'map' && parsed && <MappingStep parsed={parsed} board={board} mappings={mappings} onMapping={updateMapping} />}
        {step === 'options' && <OptionsStep dateFormat={dateFormat} setDateFormat={setDateFormat} unknownSelect={unknownSelect} setUnknownSelect={setUnknownSelect} updateKey={updateKey} setUpdateKey={setUpdateKey} updateKeys={updateKeys} />}
        {step === 'preview' && plan && <PreviewStep parsed={parsed!} plan={plan} onDownloadErrors={downloadErrors} />}
        {step === 'result' && result && <section className="space-y-3" aria-live="polite"><p className="text-sm">Import complete. {result.created} created, {result.updated} updated, {result.skipped} skipped and {result.errors} errors.</p><p className="text-xs text-neutral-500 dark:text-neutral-400">Undo is available in Settings → Local data for seven days.</p>{plan?.errors.length ? <Button size="sm" variant="outline" onClick={downloadErrors}><Download size={14} /> Download errors.csv</Button> : null}</section>}
        {error && <p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{error}</p>}
        {busy && <p role="status" className="text-sm">Importing… {progress}%</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {step !== 'file' && step !== 'result' && <Button variant="ghost" disabled={busy} onClick={() => setStep(step === 'map' ? 'file' : step === 'options' ? 'map' : 'options')}>Back</Button>}
          {step === 'map' && <Button disabled={!mappings.length} onClick={() => setStep('options')}>Next: options</Button>}
          {step === 'options' && <Button onClick={() => setStep('preview')}>Preview import</Button>}
          {step === 'preview' && <Button disabled={busy || !plan || (!plan.writes.length && !plan.links.length)} onClick={() => void importRows()}><Upload size={14} /> Import {plan?.writes.length ?? 0} rows</Button>}
          {step === 'result' && <Button onClick={onClose}>Done</Button>}
        </div>
      </div>
    </AdaptiveDialog>
  );
}

async function mutateManyChunk(collection: 'tasks' | 'links', items: { id: string; patch: Record<string, unknown> }[]): Promise<void> {
  await mutateMany(collection, items);
}

function MappingStep({ parsed, board, mappings, onMapping }: { parsed: ParsedCsv; board: BoardRow; mappings: CsvColumnMapping[]; onMapping: (index: number, target: CsvColumnMapping['target']) => void }) {
  const fields = fieldsOf(board);
  return <section className="space-y-3"><p className="text-sm">{parsed.headers.length} columns · {parsed.rows.length} data rows · delimiter {parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}</p><div className="max-h-48 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-700"><table className="w-full text-xs"><thead><tr className="border-b border-neutral-200 text-left dark:border-neutral-700"><th className="px-2 py-1.5">CSV column</th><th className="px-2 py-1.5">Map to</th></tr></thead><tbody>{parsed.headers.map((header, index) => <tr key={`${header}-${index}`} className="border-b border-neutral-100 dark:border-neutral-800"><td className="max-w-40 truncate px-2 py-1.5" title={header}>{header}</td><td className="px-2 py-1.5"><Select density="compact" aria-label={`Map ${header}`} value={mappings[index]?.target ?? 'skip'} onChange={(event) => onMapping(index, event.target.value as CsvColumnMapping['target'])}><option value="skip">Skip</option><option value="title">Title</option>{fields.map((field) => <option key={field.id} value={`p_${field.id}`}>{field.name}</option>)}{FIELD_TYPES.map((field) => <option key={`new:${field.id}`} value={`new:${field.id}`}>Create new {field.label.toLowerCase()} field</option>)}</Select></td></tr>)}</tbody></table></div><p className="text-xs text-neutral-500 dark:text-neutral-400">Auto-matching ignores case, spaces, underscores and hyphens. Relation columns require an exact target title.</p></section>;
}

function OptionsStep({ dateFormat, setDateFormat, unknownSelect, setUnknownSelect, updateKey, setUpdateKey, updateKeys }: { dateFormat: CsvImportOptions['dateFormat']; setDateFormat: (value: CsvImportOptions['dateFormat']) => void; unknownSelect: CsvImportOptions['unknownSelect']; setUnknownSelect: (value: CsvImportOptions['unknownSelect']) => void; updateKey: string; setUpdateKey: (value: string) => void; updateKeys: CsvColumnMapping[] }) {
  return <section className="space-y-4"><Field label="Date format"><Select value={dateFormat} onChange={(event) => setDateFormat(event.target.value as CsvImportOptions['dateFormat'])}><option value="yyyy-mm-dd">yyyy-mm-dd</option><option value="dd/mm/yyyy">dd/mm/yyyy</option><option value="mm/dd/yyyy">mm/dd/yyyy</option></Select></Field><Field label="Unknown select options"><Select value={unknownSelect} onChange={(event) => setUnknownSelect(event.target.value as CsvImportOptions['unknownSelect'])}><option value="add">Add them automatically</option><option value="error">Treat them as errors</option></Select></Field><Field label="Update existing records (optional)"><Select value={updateKey} onChange={(event) => setUpdateKey(event.target.value)}><option value="">Always create new records</option>{updateKeys.map((mapping) => <option key={mapping.target} value={mapping.target}>{mapping.header}</option>)}</Select></Field><p className="text-xs text-neutral-500 dark:text-neutral-400">Ambiguous dates follow the format you choose. Duplicate update keys in the file are errors.</p></section>;
}

function PreviewStep({ parsed, plan, onDownloadErrors }: { parsed: ParsedCsv; plan: CsvImportPlan; onDownloadErrors: () => void }) {
  return <section className="space-y-3"><p className="text-sm">Preview: {plan.creates} create · {plan.updates} update · {plan.skips} skip · {plan.errors.length} error</p><div className="max-h-44 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-700"><table className="w-full text-xs"><thead><tr className="border-b border-neutral-200 text-left dark:border-neutral-700"><th className="px-2 py-1.5">Row</th><th className="px-2 py-1.5">Values</th></tr></thead><tbody>{parsed.rows.slice(0, 20).map((row, index) => <tr key={index} className="border-b border-neutral-100 dark:border-neutral-800"><td className="px-2 py-1.5">{index + 2}</td><td className="max-w-72 truncate px-2 py-1.5">{row.join(' · ')}</td></tr>)}</tbody></table></div>{plan.errors.length > 0 && <Button size="sm" variant="outline" onClick={onDownloadErrors}><Download size={14} /> Download errors.csv</Button>}</section>;
}
