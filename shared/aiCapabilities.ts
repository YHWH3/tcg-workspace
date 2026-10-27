/** Shared capability registry: the ONE classification of every Workspace MCP
 * tool, used by external MCP discovery (worker/mcp.ts), the embedded assistant
 * (worker/assistant/*) and the UI. Business logic stays in the registered MCP
 * handlers; this file only classifies them.
 *
 * kind:
 *  - read      readOnlyHint tools; current read gate applies.
 *  - write     reg()-wrapped mutations; the embedded assistant ALWAYS turns
 *              them into a frozen preview requiring human approval.
 *  - proposal  persists only a proposal/preview/suggestion, never records.
 * embedded:
 *  - allow     the embedded model may call it (after server validation).
 *  - deny      human-only: approval, execution, undo, publication, outward
 *              sharing. Their Workspace UI flows remain the only path.
 * Unknown tools are treated as `write` + `deny` (tests/assistant-registry.test.ts
 * asserts the registry and the registered server match exactly). */

export type CapabilityKind = 'read' | 'write' | 'proposal';
export type CapabilityModule =
  | 'search' | 'pages' | 'editor' | 'tasks' | 'databases' | 'properties' | 'views' | 'projects'
  | 'dashboards' | 'moodboards' | 'files' | 'comments' | 'approvals' | 'people' | 'inbox'
  | 'automations' | 'history' | 'changesets' | 'workflows' | 'templates' | 'workspace';

export interface Capability {
  id: string;
  module: CapabilityModule;
  kind: CapabilityKind;
  embedded: 'allow' | 'deny';
  /** Write/proposal approval contract (informational; enforced server-side). */
  approval: 'none' | 'preview_when_significant' | 'always_human';
  /** Idempotency key accepted (`requestId`). */
  idempotent: boolean;
}

const R = (id: string, module: CapabilityModule): Capability => ({ id, module, kind: 'read', embedded: 'allow', approval: 'none', idempotent: false });
const W = (id: string, module: CapabilityModule): Capability => ({ id, module, kind: 'write', embedded: 'allow', approval: 'preview_when_significant', idempotent: true });
const P = (id: string, module: CapabilityModule): Capability => ({ id, module, kind: 'proposal', embedded: 'allow', approval: 'always_human', idempotent: true });
const H = (id: string, module: CapabilityModule): Capability => ({ id, module, kind: 'write', embedded: 'deny', approval: 'always_human', idempotent: true });

export const CAPABILITIES: readonly Capability[] = [
  // Search and knowledge discovery
  R('search', 'search'), R('fetch', 'search'), R('workspace_overview', 'workspace'), R('neighbors', 'search'),
  // Pages and editor
  R('get_page', 'pages'), W('create_page', 'pages'), W('edit_page', 'editor'), W('find_or_create_page', 'pages'),
  H('publish_page', 'pages'),
  // Tasks, databases, properties, views, projects
  R('get_board', 'databases'), W('create_board', 'databases'), W('update_board', 'databases'), W('create_database', 'databases'),
  W('create_tasks', 'tasks'), W('update_tasks', 'tasks'), R('get_task', 'tasks'),
  R('query_records', 'databases'), R('get_record', 'databases'), W('create_records', 'databases'), W('update_records', 'databases'),
  W('edit_record_body', 'editor'), W('set_parent', 'databases'), W('convert_record', 'databases'),
  W('add_stage', 'properties'), W('update_stage', 'properties'), W('remove_stage', 'properties'),
  W('add_field', 'properties'), W('update_field', 'properties'), W('remove_field', 'properties'),
  W('add_view', 'views'), W('update_view', 'views'), W('remove_view', 'views'),
  W('link_items', 'databases'), W('unlink_items', 'databases'), W('add_dependency', 'tasks'), W('remove_dependency', 'tasks'),
  W('create_project', 'projects'), W('convert_idea_to_project', 'projects'),
  W('archive_item', 'workspace'), W('unarchive_item', 'workspace'), W('delete_item', 'workspace'), W('restore_item', 'workspace'),
  // Dashboards
  R('dashboard_snapshot', 'dashboards'), R('operating_review_context', 'dashboards'), R('attention_queue','dashboards'),
  // Moodboards
  W('create_moodboard', 'moodboards'), W('add_mood_items', 'moodboards'), R('get_moodboard', 'moodboards'),
  W('update_mood_items', 'moodboards'), W('connect_items', 'moodboards'), W('add_frame', 'moodboards'),
  W('layout_moodboard', 'moodboards'), W('add_svg', 'moodboards'), W('add_diagram', 'moodboards'),
  W('update_diagram', 'moodboards'), W('board_to_canvas', 'moodboards'), H('share_moodboard', 'moodboards'),
  // Files
  R('list_attachments', 'files'),
  // Comments
  W('add_comment', 'comments'), R('list_comments', 'comments'),
  // Approvals (human decisions only)
  R('list_approvals', 'approvals'), H('request_approval', 'approvals'), H('decide_approval', 'approvals'),
  // People
  R('find_collaborators', 'people'),
  // Inbox / suggestions
  P('propose_suggestion', 'inbox'),
  R('website_query','inbox'), R('website_digest','inbox'), R('website_read_answers','inbox'), P('propose_website_triage','inbox'),
  // Automations
  R('list_automations', 'automations'),
  // History, activity, changesets
  R('get_record_history', 'history'), W('restore_record_fields', 'history'), R('recent_activity', 'history'), R('activity_for', 'history'),
  R('list_changes', 'changesets'), R('get_change', 'changesets'), H('undo_change', 'changesets'),
  // Workflows and previews
  P('propose_workflow', 'workflows'), H('execute_preview', 'workflows'),
  // Templates
  R('list_templates', 'templates'), W('create_from_template', 'templates'), W('install_template', 'templates'),
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
/** Fail closed: an unregistered tool is a human-only write. */
export function capabilityOf(id: string): Capability {
  return byId.get(id) ?? { id, module: 'workspace', kind: 'write', embedded: 'deny', approval: 'always_human', idempotent: false };
}
export const isEmbeddedAllowed = (id: string) => byId.get(id)?.embedded === 'allow';

/** Module → embedded contextual surfaces (documentation + UI grouping). */
export const MODULE_CAPABILITIES = (module: CapabilityModule) => CAPABILITIES.filter((c) => c.module === module);
