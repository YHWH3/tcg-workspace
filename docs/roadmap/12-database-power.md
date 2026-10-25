# Phase 12 — Database power (build only what Phase 8 proved necessary)

Branch `sol/p12-database-power` stacked on `sol/p11-storage`.

**Gate:** before starting, re-read the ledger. The focused calculations of 8.4
(project health), 8.5 (budget, product economics) and 8.6 (measurement chart)
must be in use. Build general rollups and formulas only if at least two
workflows need something those focused helpers cannot express. Record the
justification in PROGRESS.md. Chart view and automation branches are
independent and may proceed.

---

## 12.1 Rollup fields

- **`FieldType` adds `'rollup'`** (`shared/fields.ts`). Definition:
  `{relationFieldId, targetKey: FieldKey | 'status', agg}`.
- **Supported `agg` values:** `count`, `count_values`, `sum`, `avg`, `min`,
  `max`, `percent_checked`, `percent_done` (target status = its board's last
  column), `earliest`, `latest` (dates).
- **Computed, never stored.**
  - `fieldValue` (`shared/views.ts`) resolves `p_<rollupId>` through a new
    context hook, `ctx.computed?(recordId, fieldId)`.
  - Filters, sorts, grouping, metrics and CSV export work on rollups
    automatically.
  - `computeRollup(record, def, links, targets, targetBoard)` is pure, in
    `shared/rollups.ts`.
- **Currency:** a sum or average over a currency field inherits that field's
  currency. A rollup over fields with mixed currencies is refused (7.2 rule).
- **Permissions:**
  - computed over the target records the viewer can read; the cell tooltip says
    "of N accessible records";
  - with permissions disabled, the computation covers all records.
- **Server (MCP `query_records`, `get_record`, `dashboard_snapshot`):**
  - compute using bounded link and target loads, at most 2,000 targets per call;
  - beyond that, return `partial:true` and the value over the loaded subset,
    marked as partial;
  - the app and MCP use the same `computeRollup`.
- **UI:** the field editor gets a rollup builder (relation → target field →
  aggregation), and cells are read-only. On compact screens, the builder is a
  full-screen sheet.
- **Pack upgrade:** offer, but do not force, rollups for Projects (Spent = sum
  of expense Transactions, % tasks done) and Programs (project count). The 8.5
  helpers remain for the budget block.
- **Tests:**
  - Unit: each aggregation, empty sets, deleted or archived targets excluded,
    mixed currency.
  - D1: MCP parity, partial flag and budget.
  - Browser: build a rollup by keyboard.

## 12.2 Formula fields

- **`FieldType` adds `'formula'`**, with definition `{expression: string}`
  (≤500 characters).
- **Language** (`shared/formula.ts`): a parser and evaluator with **no `eval`
  and no `Function`**.
  - Literals: number, string, boolean, date `date("2026-10-25")`.
  - Field references: `prop("Field name")`, resolved by name at save time to a
    field id and stored as `{expression, refs}`; renames do not break formulas.
  - Operators: `+ - * / % == != < <= > >= and or not`.
  - Functions: `if`, `ifs`, `empty`, `round`, `floor`, `ceil`, `abs`, `min`,
    `max`, `concat`, `lower`, `upper`, `length`, `contains`, `today()`
    (workspace today, 7.2), `dateAdd(d, n, "days"|"months")`,
    `dateBetween(a, b, "days")`, `format(n)`.
  - Types are checked at save time; the result type is one of number, text,
    date or boolean, and is stored on the definition for sort and filter.
  - Limits: depth ≤20, evaluation steps ≤10,000 (fail with `#LIMIT`).
  - Formulas may reference rollups and other formulas: a cycle check at save
    time, a chain of at most 5.
- **Errors:** show `#ERROR` in the cell with a tooltip; filters treat errors as
  empty.
- **Computed via the same hook as 12.1;** MCP parity.
- **Pack:** Common Cupboard can gain a formula "Margin (computed)" =
  `prop("Price") - prop("Cost")` beside the original text Margin (never delete
  it).
- **Tests:** a parser fuzz test (fast-check is available), golden tests per
  function, type errors, cycles, limits and timezone for `today()`.

## 12.3 Chart view

Follow the AGENTS.md "Add a view type" checklist:

1. Extend `VIEW_TYPES` with `'chart'` and the config
   `{chartType:'bar'|'stacked_bar'|'line', xKey: FieldKey, xBucket?: 'day'|'week'|'month', yAgg:'count'|'sum'|'avg', yKey?: FieldKey, seriesKey?: FieldKey}`.
2. Pure `chartSeries(rows, cfg, ctx)` in `shared/charts.ts` reuses `applyView`
   filters and `aggregate` semantics.
3. Add a render branch in the database view switch (`src/modules/boards/`,
   `src/core/views/`). The renderer is SVG with no chart library, and must
   handle:
   - colour palette that works in light and dark (reuse design tokens);
   - an accessible `<title>`/`<desc>`, plus a "Show as table" toggle;
   - keyboard focus on bars and points, with values announced;
   - drill-down to records on click or Enter.
4. Accept it in MCP `add_view` / `update_view`. `query_records` with a chart
   view returns the series.
5. Cover it in `tests/views.test.ts` and `scripts/verify-mcp-phase1.mjs`.

The 8.6 `measurechart` block stays the field-specific tool. `view` blocks can
embed chart views on dashboards.

## 12.4 Automation branches (if/else)

- Additive automation shape (`shared/automations.ts`):
  `branches?: {name?: string; conditions: Filter[]; actions: Action[]}[]`,
  `otherwise?: Action[]`.
  - Evaluation runs the first matching branch; otherwise `otherwise`.
  - With no `branches`, the legacy `conditions` + `actions` behaviour is
    unchanged.
- **Validation** (`validateAutomation`): at most 5 branches and 10 actions per
  branch; same action validation.
- **Execution:** the durable path is unchanged; the selected branch index is
  recorded in `automation_runs` (add a nullable column `branch` in this phase's
  migration) for the health view (8.10).
- **Editor UI:** a branch list with conditions (reusing the 7.1 date controls)
  and actions; keyboard reorderable.
- **Tests:** unit evaluation and validation; D1 durable run with branches.

## 12.5 Moodboard export

- Client-side: render canvas items (positions and sizes from the stored items,
  `shared/canvasLayout.ts`) to a standalone SVG, embedding images as data URLs
  from local blobs. Fetch missing ones with the existing `useFileUrl` logic
  first; otherwise use a placeholder.
- Export as SVG or PNG (rasterize via canvas), for the selection or the whole
  board; PDF via print styles.
- The SVG passes through the existing `svgSanitize` before download.
- **Tests:** unit SVG generation; browser export on three engines.
