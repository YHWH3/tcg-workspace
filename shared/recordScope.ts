import { isCollection } from './collections';

/** `rootSpaceId` is server-owned records.space_id (or a separately authorized
 * root destination). data.spaceId is deliberately NEVER authority here. */
export interface ScopeRecord {
  id: string;
  collection: string;
  data: Readonly<Record<string, unknown>>;
  rootSpaceId?: string;
}

export interface RecordScope {
  spaceId: string;
  /** A cross-space relation requires read access to every endpoint's scope. */
  readSpaceIds: readonly string[];
  /** Pending public-form files require their separate claim/service capability. */
  serviceOnly: boolean;
  ancestorDeleted: boolean;
}

export class ScopeError extends Error {
  constructor(public readonly code: 'parent_unavailable' | 'invalid_parent' | 'scope_cycle' | 'scope_depth' | 'invalid_scope') {
    super(code); this.name = 'ScopeError';
  }
}

export const MAX_SCOPE_DEPTH = 64;
const CORE = 'space-core';
const DEFAULT_BOARD = 'board-default';
const targetCollections: Readonly<Record<string, string>> = {
  page: 'pages', record: 'tasks', task: 'tasks', block: 'blocks', comment: 'comments',
  board: 'boards', moodboard: 'moodboards', mooditem: 'mooditems', file: 'files',
  form: 'forms', automation: 'automations',
};
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;

/** Candidate ancestry seeds. Type/existence/cycle checks remain in resolver.
 * Invalid values are not sent as database IDs and subsequently fail resolution. */
export function scopeParentIds(record: ScopeRecord): string[] {
  const d = record.data;
  let values: unknown[];
  switch (record.collection) {
    case 'pages': values = [d.parentId]; break;
    case 'tasks': values = [d.boardId ?? DEFAULT_BOARD, d.parentId]; break;
    case 'blocks': values = [d.pageId]; break;
    case 'views': case 'forms': values = [d.databaseId]; break;
    case 'mooditems': values = [d.boardId]; break;
    case 'comments': case 'activity': values = [d.targetId]; break;
    case 'files': values = [d.parentId]; break;
    case 'automations': values = [(plainObject(d.trigger) ? d.trigger.databaseId : undefined) ?? d.databaseId]; break;
    case 'links': values = [d.fromId, d.toId]; break;
    default: values = [];
  }
  return [...new Set(values.filter(id))];
}

/** Build once for a coherent, server-loaded graph including proposed mutations.
 * Missing dependencies are a denial, never an implicit move to Core. Loading
 * the graph, checking effective capabilities and fencing writes are the server
 * caller's responsibilities. This planner does not itself authorize a write. */
export function scopeResolver(records: ReadonlyMap<string, ScopeRecord>): (recordId: string) => RecordScope {
  const cache = new Map<string, RecordScope>();
  const visiting = new Set<string>();
  function resolve(recordId: string, depth = 0): RecordScope {
    if (visiting.has(recordId)) throw new ScopeError('scope_cycle');
    if (depth > MAX_SCOPE_DEPTH) throw new ScopeError('scope_depth');
    const known = cache.get(recordId); if (known) return known;
    const record = records.get(recordId);
    if (!record) throw new ScopeError('parent_unavailable');
    if (record.id !== recordId || !id(recordId) || !isCollection(record.collection) || !plainObject(record.data)) throw new ScopeError('invalid_scope');
    visiting.add(recordId);
    try {
      const d = record.data;
      function parent(parentId: unknown, collections: readonly string[]): RecordScope {
        if (!id(parentId)) throw new ScopeError('invalid_parent');
        const p = records.get(parentId);
        if (!p) throw new ScopeError('parent_unavailable');
        if (!collections.includes(p.collection)) throw new ScopeError('invalid_parent');
        const resolved = resolve(parentId, depth + 1);
        return { ...resolved, ancestorDeleted: resolved.ancestorDeleted || p.data.deleted === true };
      }
      function root(): RecordScope {
        const spaceId = record!.rootSpaceId ?? CORE;
        if (!id(spaceId)) throw new ScopeError('invalid_scope');
        return { spaceId, readSpaceIds: [spaceId], serviceOnly: false, ancestorDeleted: false };
      }
      function target(type: unknown, targetId: unknown): RecordScope {
        if (typeof type !== 'string' || !Object.hasOwn(targetCollections, type)) throw new ScopeError('invalid_parent');
        return parent(targetId, [targetCollections[type]]);
      }
      let scope: RecordScope;
      switch (record.collection) {
        case 'boards': case 'moodboards': scope = root(); break;
        case 'pages':
          scope = d.parentId === undefined || d.parentId === null || d.parentId === '' ? root() : parent(d.parentId, ['pages']);
          break;
        case 'blocks': scope = parent(d.pageId, ['pages', 'tasks']); break;
        case 'tasks': {
          const boardId = d.boardId === undefined || d.boardId === null ? DEFAULT_BOARD : d.boardId;
          // The built-in default board can precede its ts=1 seed. An explicit
          // real default board always wins, including its authorized scope.
          scope = boardId === DEFAULT_BOARD && !records.has(DEFAULT_BOARD)
            ? { spaceId: CORE, readSpaceIds: [CORE], serviceOnly: false, ancestorDeleted: false }
            : parent(boardId, ['boards']);
          if (d.parentId !== undefined && d.parentId !== null && d.parentId !== '') {
            const p = parent(d.parentId, ['tasks']);
            const parentRecord = records.get(String(d.parentId))!;
            if ((parentRecord.data.boardId ?? DEFAULT_BOARD) !== boardId || p.spaceId !== scope.spaceId) throw new ScopeError('invalid_parent');
            scope = { ...scope, ancestorDeleted: scope.ancestorDeleted || p.ancestorDeleted };
          }
          break;
        }
        case 'views': scope = parent(d.databaseId, ['boards']); break;
        case 'mooditems': scope = parent(d.boardId, ['moodboards']); break;
        case 'comments': scope = target(d.targetType, d.targetId); break;
        case 'activity':
          scope = d.targetId === undefined || d.targetId === null || d.targetId === ''
            ? { spaceId: CORE, readSpaceIds: [CORE], serviceOnly: false, ancestorDeleted: false }
            : target(d.targetType, d.targetId);
          break;
        case 'files':
          scope = d.parentType === 'form-pending'
            ? { ...parent(d.parentId, ['forms']), serviceOnly: true }
            : target(d.parentType, d.parentId);
          if (!['task', 'block', 'mooditem', 'form-pending'].includes(String(d.parentType))) throw new ScopeError('invalid_parent');
          break;
        case 'forms': scope = parent(d.databaseId, ['boards']); break;
        case 'automations': {
          const databaseId = (plainObject(d.trigger) ? d.trigger.databaseId : undefined) ?? d.databaseId;
          // Phase 4 permits unscoped rules. Their configuration remains Core;
          // action source/destination permissions require additional checks.
          scope = databaseId === undefined || databaseId === null
            ? { spaceId: CORE, readSpaceIds: [CORE], serviceOnly: false, ancestorDeleted: false }
            : parent(databaseId, ['boards']);
          break;
        }
        case 'links': {
          const from = target(d.fromType, d.fromId), to = target(d.toType, d.toId);
          scope = {
            spaceId: from.spaceId,
            readSpaceIds: [...new Set([...from.readSpaceIds, ...to.readSpaceIds])].sort(),
            serviceOnly: from.serviceOnly || to.serviceOnly,
            ancestorDeleted: from.ancestorDeleted || to.ancestorDeleted,
          };
          break;
        }
        default: throw new ScopeError('invalid_scope');
      }
      cache.set(recordId, scope);
      return scope;
    } finally { visiting.delete(recordId); }
  }
  return recordId => resolve(recordId);
}
