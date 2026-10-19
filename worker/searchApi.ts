/** `GET /api/search?q=&type=&database=&cursor=&limit=` — the permission-aware search service
 * (worker/search.ts) for the app. At most 50 results per page, an opaque keyset cursor and
 * `hasMore`; no totals, ranks or timings. `indexPending` says the index is catching up. */
import {hybridSearch} from './aiSemantic';
import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { withReadGate } from './readAccess';
import { SEARCH_MAX_LIMIT, SearchError, type SearchType } from './search';

export const searchApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
searchApi.use('*', requireAuth);

const TYPES = new Set(['page', 'task', 'board', 'moodboard', 'comment', 'file', 'mooditem']);
const URL_OF: Record<SearchType, (id: string, db: string | null) => string> = {
  page: (id) => `/pages/${id}`, task: (id, db) => `/boards/${db ?? 'board-default'}/tasks/${id}`,
  board: (id) => `/boards/${id}`, moodboard: (id) => `/moodboards/${id}`, comment:()=>'/', file:()=>'/', mooditem:()=>'/',
};

searchApi.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q') ?? '', type = c.req.query('type'), limit = Number(c.req.query('limit') ?? 20);
  if (q.length > 200 || (type && !TYPES.has(type)) || !Number.isFinite(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) return c.json({ error: 'invalid_query' }, 400);
  try {
    const mode=c.req.query('mode')??'keyword';if(!['keyword','semantic','hybrid'].includes(mode))return c.json({error:'invalid_mode'},400);
    const out = await hybridSearch(withReadGate(c.env, user.id), user.id, { q, spaceId:c.req.query('space') || undefined, type: type as SearchType | undefined, databaseId: c.req.query('database') || undefined, cursor: c.req.query('cursor') || null, limit },mode as 'keyword'|'semantic'|'hybrid');
    return c.json({ ...out, results: out.results.map((r) => ({ id: r.docId, type: r.type, title: r.title, url: r.url ?? URL_OF[r.type](r.docId, r.databaseId), snippet: r.snippet })) });
  } catch (error) {
    if (error instanceof SearchError) return c.json({ error: error.code }, 400);
    throw error;
  }
});
