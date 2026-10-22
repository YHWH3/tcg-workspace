/* One shared contextual "Ask AI" menu for every surface (pages, records,
 * databases, moodboards, dashboards, inbox, automations, people). Actions come
 * only from the shared catalog (`actionsFor(module)`), never hard-coded
 * instructions. Choosing one opens the assistant with exactly the context the
 * action needs; the footer discloses where that context is sent before the
 * click. */
import { useRef } from 'react';
import { Sparkles, MessageSquarePlus } from 'lucide-react';
import { actionsFor, type ActionModule, type AiAction } from '../../../shared/aiActions';
import type { ContextRef } from '../../../shared/assistantProtocol';
import { Popover } from '../ui';
import { useStore } from '../store';
import { cn } from '../utils';
import { assistantStore, ensureProviders, openAssistant, selectedProvider } from './store';

export type ContextRefs = Partial<Record<ContextRef['kind'], ContextRef>>;

const MODULE_HEADINGS: Partial<Record<ActionModule, string>> = {
  pages: 'Page',
  notes: 'Notes',
  tasks: 'Task',
  projects: 'Project',
  databases: 'Database',
  dashboards: 'Dashboard',
  moodboards: 'Moodboard',
  people: 'People',
  inbox: 'Inbox item',
  automations: 'Automations',
  selection: 'Selection',
  search: 'Workspace',
};

/** Context an action needs, or null when the surface cannot supply it. */
export function contextForAction(a: AiAction, refs: ContextRefs): ContextRef[] | null {
  const out: ContextRef[] = [];
  for (const k of a.context) {
    const r = refs[k];
    if (!r) return null;
    out.push(r);
  }
  return out;
}

export function ProviderDisclosure({ className }: { className?: string }) {
  const s = useStore(assistantStore);
  const p = selectedProvider(s);
  let text: string;
  if (s.providersState === 'loading' || s.providersState === 'idle') text = 'Checking AI providers…';
  else if (s.providersState === 'error') text = 'AI providers unavailable offline. Workspace features keep working.';
  else if (!p) text = 'No AI provider selected — opening the assistant shows your options.';
  else text = p.egressHost ? `Uses ${p.label}. Context you attach is sent to ${p.egressHost}.` : `Uses ${p.label}.`;
  return <p className={cn('text-[11px] leading-4 text-neutral-500 dark:text-neutral-400', className)}>{text}</p>;
}

export function AskAiMenu({
  modules,
  refs,
  primary,
  label = 'Ask AI',
  compact = false,
  align = 'right',
  className,
}: {
  modules: ActionModule[];
  refs: ContextRefs;
  /** Context for the free-form "Ask about this…" entry (defaults to the first ref). */
  primary?: ContextRef | null;
  label?: string;
  /** Icon-only trigger (accessible name stays `label`). */
  compact?: boolean;
  align?: 'left' | 'right';
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = modules
    .map((m) => ({ module: m, actions: actionsFor(m).flatMap((a) => { const ctx = contextForAction(a, refs); return ctx ? [{ a, ctx }] : []; }) }))
    .filter((g) => g.actions.length);
  const ask = primary === undefined ? (Object.values(refs)[0] ?? null) : primary;
  const itemCls = 'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-400 dark:text-neutral-200 dark:hover:bg-neutral-800';
  return (
    <Popover
      align={align}
      adaptive
      label={label}
      onOpenChange={(open) => {
        if (open) void ensureProviders();
      }}
      className="w-72"
      trigger={
        <button
          ref={trigger}
          type="button"
          data-testid="ask-ai-menu"
          aria-label={compact ? label : undefined}
          title={label}
          className={cn(
            'inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white',
            className,
          )}
        >
          <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
          {!compact && <span>{label}</span>}
        </button>
      }
    >
      {(close) => (
        <div className="p-1.5" data-testid="ask-ai-menu-list">
          {groups.map((g) => (
            <div key={g.module} role="group" aria-label={`${MODULE_HEADINGS[g.module] ?? g.module} actions`} className="mb-1">
              <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400" aria-hidden="true">
                {MODULE_HEADINGS[g.module] ?? g.module}
              </p>
              {g.actions.map(({ a, ctx }) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`ask-ai-action-${a.id}`}
                  className={itemCls}
                  onClick={() => {
                    close();
                    openAssistant({ context: ctx, actionId: a.id, opener: trigger.current });
                  }}
                >
                  <Sparkles size={14} className="shrink-0 text-violet-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{a.label}</span>
                  {a.output === 'proposal' && <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">Review first</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              close();
              openAssistant({ context: ask ? [ask] : [], opener: trigger.current });
            }}
          >
            <MessageSquarePlus size={14} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">Ask a question…</span>
          </button>
          <ProviderDisclosure className="px-2.5 pb-1.5 pt-1" />
        </div>
      )}
    </Popover>
  );
}
