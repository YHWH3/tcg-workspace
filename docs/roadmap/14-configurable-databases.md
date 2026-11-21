# Configurable databases and MCP

Base reviewed for this work is Workspace `b31c6e8`. The Common Ground Website
inbox remains one configuration of the same database engine. Project-specific
databases use the same records, fields, saved views, forms, access and sync.

## Product comparison and source audit

The reference shows a saved-view picker. A database can have several views of
one layout, each with its own name and settings. Selecting a different layout
opens the same records in a different presentation.

| Feature | What it does | Workspace before this change |
|---|---|---|
| Grid or table | Edit records and properties as rows and columns | Table view, column and property settings |
| Board | Move cards between workflow stages or property groups | Stages and a property-group board, plus an older board toolbar that did not expose saved views |
| Calendar | Schedule records by one date | Saved calendar view with date-field selection |
| Timeline | See start-to-end ranges and dependencies | Saved timeline with date keys and scale |
| Chart | Visualize counts, sums, averages, and time series | Saved chart with accessible data table and MCP series |
| List | Scan compact rows | Saved list |
| Gallery | Browse cards with images and properties | Saved gallery |
| Feed | Read updates as stacked cards | No record Feed layout. Activity lists change events |
| Form builder | Collect typed answers into new database records | Forms under the database menu, with a separate authenticated publication flow |
| Dashboard | Keep a group of views and metrics together | Configurable Database view and Metric page blocks, plus dashboard reads on MCP. Composition through MCP was missing |

Sources matched to the screenshots include the [AppFlowy release notes](https://appflowy.com/what-is-new),
[Notion’s view settings](https://www.notion.com/help/views-filters-and-sorts),
[Feed](https://www.notion.com/help/feeds), [forms](https://www.notion.com/help/forms)
and [dashboards](https://www.notion.com/help/dashboards). Both products help
validate the concepts. Workspace uses its own components, layout and routes.
Visible names and labels accompany color. The compact picker uses a sheet and
returns focus to the action that opened it. [W3C use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
and [Material menus](https://m3.material.io/components/menus/accessibility).
Notion also documents separate [MCP database and view operations](https://developers.notion.com/guides/mcp/tools-databases)
and a [database template](https://www.notion.com/help/database-templates) for
repeatable record bodies. Those are useful reference points for the parity audit.

The existing MCP inventory includes pages, records, fields and stages,
relations, templates, moodboards, record history, chart aggregation, and
approval-backed writes. It provided no saved-view inventory, exact settings copy,
shared-default setter, draft form editing, or dashboard block composition.
Saved-view queries accepted chart IDs only.

## Stage 1. Make the existing options visible

> Surface saved views on older task boards. Keep the add-view button reachable
> when many tabs scroll. Explain each layout, show form creation in the same
> picker, and make the active view’s options reachable without hover. Copy a
> view’s settings without copying any records. Show colored stage labels, visible
> card move controls, a named stage color palette and an accessible progress meter.
> Keep labels and keyboard focus clear in light and dark themes.

Acceptance covers keyboard access, compact and enlarged layouts, independent
configurations, date selection, and preserved stage-approval paths.

## Stage 2. Add a reusable Feed and align MCP with saved views

> Add a stacked Feed with readable titles, summary text, selected properties,
> sorting, filtering, grouping and record links. Embed it through the existing
> Database view block. Share the view-type registry across browser and server.
> Add Dashboard to the same picker with live totals and stage drill-down.
> Support saved-view discovery, copying, querying, and default selection in MCP.
> A dashboard query returns the same totals, stage counts and stage colors.

Acceptance covers creation and copying through the UI and MCP, newest-first
default, a saved filter over the same record IDs, wrong database rejection,
write permissions, expected revisions, and safe retry.

## Stage 3. Let AI compose dashboard pages and draft intake forms

> Append saved-view and metric blocks to an existing page using the canonical
> write path. Let MCP list draft form configurations and create or edit drafts
> with the existing form validator. Return clickable editor links. Preserve
> browser-controlled publication and the existing live-form capability boundary.

`list_database_views` supplies a typed output schema and a JSON text fallback
for portability. Mutation tools take scoped IDs and request IDs. New actions
can be previewed and use the existing changeset and approval path. Work is
bounded per request. A saved-view query evaluates up to 5,000 database records
and fails explicitly above that bound. Listing caps are explicit and exact-ID
lookups remain available. [MCP tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

## Subsequent coverage

| Family | Next implementation and evidence |
|---|---|
| Dashboard layout | Add editable in-page widget grouping or grids only once the existing blocks have been reviewed in a portable project. Test compact and keyboard reorder before extending the tool schema. |
| Reusable project setup | Test a blank project and an unrelated client project from existing project and template tools. Inventory gaps in database and page placement in Spaces, reusable templates, and cross-project dashboard visibility. |
| Advanced configuration | Audit per-view column presentation, database and record templates, generic computed properties, buttons and automation administration against real example workflows. Verify formula and rollup demand and access boundaries before implementing either. |
| Broad MCP parity | Inventory every browser action. Add tools for missing authorized actions in domain groups, using exact IDs, typed results, explicit pagination and preview where appropriate. Keep account/security consent, public activation and destructive approval in their existing authenticated flows. |
| Client acceptance | Test tool discovery and Streamable HTTP/OAuth with the relevant clients. Client support for remote transport, OAuth, writable tools and structured results can vary. Hosted connector, physical-device and screen-reader acceptance remain separate. |

Public publishing and Website integration are outside this change.

## Try a project

Use the [Studio demo and handoff](studio-demo/README.md) to review a complete, fictional workspace or as a brief for configuring another project.

Create a database for your own project in **Boards**. Open **Saved views** on a
task board or **+ View** on a database. Add a Board for delivery, a Calendar for
deadlines, a Feed for updates, and a Dashboard for status and counts. Use each view’s options to duplicate
it, rename it or set it as the shared default. A percentage number property
shown on board cards uses a fraction such as `0.5` for 50%.

For a dashboard with multiple widgets, use **Database view** on a page from the slash menu and choose the database
and saved view. Add a **Metric** block to show a count, sum or average alongside
it. The **Form builder** picker entry opens the database’s intake forms.

Over MCP, use `workspace_overview` to find database and page IDs, then
`list_database_views` or `list_database_forms` to discover current configuration.
`query_records` takes the saved view ID. Use `append_dashboard_widgets` to
compose the page and `save_form_draft` to prepare an intake form. For a draft
update pass its latest revision. Where access control is enabled, the MCP
dashboard composer puts source views on pages in the same Space.
