// The Website section: forms and patron events from The Common Ground website
// (docs/integrations/the-common-ground.md). A dashboard over the local Website
// inbox rows — same card language as the page dashboard blocks, figures from
// shared/websiteStats.ts (also behind the digest and MCP) — plus links into
// the inbox views. Works offline from local data; never calls a model.

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, Clock, Globe, Inbox, Sparkles, Ticket, TrendingUp } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { EmptyState, Spinner } from '../../core/ui';
import { cn } from '../../core/utils';
import { recordHref } from '../../../shared/recordRoutes';
import { WEBSITE_INBOX_ID, websiteInboxViews } from '../../../shared/websiteInbox';
import { websiteDashboard,responseConfig, type FlatRecord } from '../../../shared/websiteStats';
import {useWorkspaceLocale,workspaceTimeZone} from '../../core/workspaceLocale';
import {ResponseDesk} from './ResponseDesk';
import type { AppModule } from '../types';

const card = 'flex min-w-0 flex-col gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900/40';
const linkRow = 'flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-800';

function Card({ icon: Icon, title, id, children }: { icon: typeof Globe; title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={card}>
      <h2 id={id} className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <Icon size={15} className="shrink-0 text-neutral-400" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Count with an expandable list of the exact records behind it. */
function Drill({ label, ids, titles }: { label: ReactNode; ids: string[]; titles: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  if (!ids.length) return <div className="flex min-h-11 items-center justify-between px-2 text-sm text-neutral-500 dark:text-neutral-400">{label}</div>;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(linkRow, 'w-full justify-between text-left')}>
        {label}
      </button>
      {open && (
        <ul className="mb-1 ml-2 border-l border-neutral-200 pl-2 dark:border-neutral-800">
          {ids.slice(0, 50).map((id) => (
            <li key={id}>
              <Link to={recordHref(WEBSITE_INBOX_ID, undefined, id)} className={cn(linkRow, 'break-words')}>
                {titles.get(id) ?? 'Untitled'}
              </Link>
            </li>
          ))}
          {ids.length > 50 && <li className="px-2 py-1 text-xs text-neutral-500">and {ids.length - 50} more in the inbox views</li>}
        </ul>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function WebsitePage() {
  const board = useLiveQuery(() => db.boards.get(WEBSITE_INBOX_ID), []) as LocalRow | undefined | null;
  const rows = useLiveQuery(() => db.tasks.where('boardId').equals(WEBSITE_INBOX_ID).toArray(), []) as LocalRow[] | undefined;
  const locale=useWorkspaceLocale();
  const now = useMemo(() => Date.now(), [rows,locale.today]);
  const stats = useMemo(() => (rows ? websiteDashboard(rows.filter((r) => !r.parentId) as FlatRecord[], now,5,{...responseConfig(board),today:locale.today,timeZone:workspaceTimeZone()}) : null), [rows, now,board,locale.today,locale.settings?.timeZone]);
  const titles = useMemo(() => new Map((rows ?? []).map((r) => [r.id, String(r.title ?? 'Untitled')])), [rows]);
  const views = websiteInboxViews();

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-2 py-6 sm:px-4 md:px-8 md:py-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Globe size={20} className="text-neutral-400" aria-hidden />
              Website
            </h1>
            <p className="mt-1 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
              Forms and patron events from thecommonground.living. Every submission is also emailed to the team; here is where you work on them.
            </p>
          </div>
          <Link
            to={`/boards/${WEBSITE_INBOX_ID}`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-sm font-medium text-white outline-none hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            <Inbox size={15} aria-hidden />
            Open the inbox
          </Link>
        </header>

        {rows === undefined || board === undefined ? (
          <div className="flex items-center gap-2 py-16 text-sm text-neutral-500" role="status">
            <Spinner size={14} /> Loading the Website inbox…
          </div>
        ) : !board || board.deleted ? (
          <EmptyState icon={Globe} title="No website submissions yet" body="The Website inbox appears with the first form from the website, once the workspace's ingest settings are on (see the README)." />
        ) : (
          <>
            <p className="sr-only" role="status">
              {plural(stats!.total, 'submission')}, {stats!.open} open.
            </p>
            <ResponseDesk rows={rows} board={board} stats={stats!}/>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Card icon={TrendingUp} title="New this week" id="wb-new">
                <p className="text-3xl font-semibold tabular-nums tracking-tight">
                  {stats!.newThisWeek.reduce((n, f) => n + f.count, 0)}
                  <span className="ml-2 text-sm font-normal text-neutral-500 dark:text-neutral-400">in the last 7 days</span>
                </p>
                <div className="-mx-2">
                  {stats!.newThisWeek.map((f) => (
                    <Drill key={f.family} ids={f.ids} titles={titles} label={<><span>{f.name}</span><span className="tabular-nums text-neutral-500 dark:text-neutral-400">{f.count}</span></>} />
                  ))}
                </div>
              </Card>

              <Card icon={Ticket} title="Patron applications" id="wb-patrons">
                <div className="-mx-2">
                  <Drill ids={stats!.openPatron.ids} titles={titles} label={<><span>Open applications (applied or approved)</span><span className="text-lg font-semibold tabular-nums">{stats!.openPatron.count}</span></>} />
                </div>
                <h3 className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Editions left</h3>
                <ul className="flex flex-col gap-2.5">
                  {stats!.editionsLeft.map((t) => (
                    <li key={t.tier} className="text-sm">
                      <div className="mb-1 flex justify-between gap-2">
                        <span className="capitalize">{t.tier}</span>
                        <span className="tabular-nums text-neutral-600 dark:text-neutral-400">{t.left} of {t.cap} left</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800" role="meter" aria-valuemin={0} aria-valuemax={t.cap} aria-valuenow={t.left} aria-label={`${t.tier} editions left`}>
                        <div className="h-full rounded-full bg-neutral-800 dark:bg-neutral-300" style={{ width: `${(t.left / t.cap) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Counted from paid and minted records here; the website's own stock is the final word.</p>
              </Card>

              <Card icon={Clock} title="Time to first reply" id="wb-reply">
                {stats!.medianFirstReplyDays === null ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">No replies recorded yet. Moving a submission to Replied records its first reply date.</p>
                ) : (
                  <p className="text-3xl font-semibold tabular-nums tracking-tight">
                    {stats!.medianFirstReplyDays === 0 ? 'Same day' : plural(stats!.medianFirstReplyDays, 'day')}
                    <span className="mt-1 block text-sm font-normal text-neutral-500 dark:text-neutral-400">median, from {plural(stats!.repliedCount, 'replied submission')}</span>
                  </p>
                )}
              </Card>

              <Card icon={Inbox} title="Oldest unanswered" id="wb-oldest">
                {stats!.oldestUnanswered.length ? (
                  <ol className="-mx-2">
                    {stats!.oldestUnanswered.map((r) => (
                      <li key={r.id}>
                        <Link to={recordHref(WEBSITE_INBOX_ID, undefined, r.id)} className={cn(linkRow, 'justify-between')}>
                          <span className="min-w-0 break-words">{r.title}</span>
                          <span className="shrink-0 tabular-nums text-xs text-neutral-500 dark:text-neutral-400">{r.ageDays === null?'Date unavailable':r.ageDays === 0 ? 'today' : plural(r.ageDays, 'day')}</span>
                        </Link>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">Everything has a reply. Nothing is waiting.</p>
                )}
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{plural(stats!.open, 'submission')} open in New or In review.</p>
              </Card>

              <Card icon={ArrowUpRight} title="Views" id="wb-views">
                <ul className="-mx-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
                  {views.map((v) => (
                    <li key={v.id}>
                      <Link to={`/boards/${WEBSITE_INBOX_ID}/views/${v.id}`} className={linkRow}>
                        {v.data.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card icon={Sparkles} title="AI help (optional)" id="wb-ai">
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  When AI classification is on, new submissions get a suggested priority, topic and spam check. Suggestions are labelled as AI and change nothing until someone accepts them. AI assistants connected over MCP can summarise and propose triage for many submissions at once; you approve each change set.
                </p>
                <Link to="/ai" className={cn(linkRow, '-mx-2 underline')}>
                  Review AI suggestions
                </Link>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const websiteModule: AppModule = {
  id: 'website',
  label: 'Website',
  icon: Globe,
  // Sidebar and the compact menu drawer only: the compact tab bar stays short.
  navItem: { path: '/website', label: 'Website', icon: Globe, tab: false },
  routes: [{ path: 'website', element: <WebsitePage /> }],
  collections: [],
};
