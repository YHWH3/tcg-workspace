# UI follow-up after human browsing

The 2026-10-23 human screenshots exposed obvious UI failures that the earlier acceptance did not cover. The 34-gate certificate at eaaa325 is valid for its recorded source and assertions; it is not evidence that the whole product's UX is acceptable. UI acceptance was returned to HOLD while these findings were corrected.

## Confirmed findings and corrections

| ID | Impact | Finding | Correction |
|---|---|---|---|
| UI01 | High | Table select labels clipped vertically: a 28px control had 8px top/bottom padding and a 20px line box, leaving 10px for the label. | Shared form defaults move into the components CSS layer. Explicit compact density replaces fixed-height overrides at 44 Input/Select call sites. Caller utilities can override defaults predictably; controls grow with their text. |
| UI02 | High | Native dropdowns were displaced and oversized; part of the browser window remained unused. | Human review uses the actual browser window with viewport:null and native Retina scale. The old launcher emulated a fixed viewport at DPR 1 on a DPR 2 display. No custom replacement for native selects is introduced. |
| UI03 | Medium | Nine form-family tabs pushed filter/sort/property actions offscreen. | Tabs keep their own horizontal strip; a separate wrapping toolbar keeps view controls visible. |
| UI04 | Medium | Truncated editable titles/emails cut off without ellipsis or a full-value hint; opening a record used a tiny hover-only target. | Wider sensible defaults, ellipsis and full-value title hints, and a larger record-detail action reachable through focus/touch. |
| UI05 | High | A grid role wrapped a separate HTML table and unrelated actions; resize separators lacked their current value and bounds. | The table keeps native semantics inside a labelled scrollable region. Resize handles announce pixel widths/bounds and preserve keyboard resizing. |
| UI06 | High | Tablist contained unrelated menu buttons and lacked arrow/Home/End navigation. | Only tabs are in the tablist; menus sit alongside it. Active-tab focus and arrow/Home/End navigation are supported. |
| UI07 | High | A draggable pipeline card was exposed as a button containing other buttons; its title target was too short. | Card container is a group with pointer dragging, real named buttons and a minimum 24px title target. Existing Move to menu remains the keyboard/touch alternative to dragging. |
| UI08 | Medium | New-row/view actions, dark toolbar labels and colored field chips failed contrast checks. | Use existing readable neutral tones for actions. Field chips preserve their chosen hue/tint while mixing text toward black/white for light/dark appearances. |

## Evidence scope and regression changes

- `scripts/control-geometry.mjs` checks actual rendered content-box height against the text line box. Axe alone cannot detect glyphs clipped inside a form control.
- `scripts/verify-website-ui.mjs` now visits and audits the inbox table and patron pipeline, not only the Website dashboard. It checks light/dark appearances, control geometry, editing/reload, full-value hints, keyboard resizing, tab navigation and toolbar visibility in Chromium/Firefox/WebKit at compact/tablet/desktop sizes.
- `scripts/verify-release-ui.mjs` applies the geometry check across its existing shell/settings/search/AI/detail acceptance.
- `scripts/verify-v6.mjs` selects the labelled table via a test ID instead of relying on the invalid grid role. Existing data/editing assertions are retained.
- `scripts/prepare-website-review.mjs` prepares separate synthetic pending approval and inbox tabs in a native-size browser. It never approves or executes the human review proposal. Use the protected local fixture CA via NODE_EXTRA_CA_CERTS; no global trust change.

Baseline evidence: `.artifacts/website-table-baseline.log` reproduces the clipped Stage/Family/Event labels against the pre-fix built application. Expanded accessibility failures and intermediate test failures remain in `.artifacts/`; they are not counted as passing results.

Final commands, source hashes, exact exits, screenshots and platform results are recorded in the ignored machine ledger and follow-up report after checks finish. Source changes invalidate affected evidence. Original checkouts, unrelated PRs, website design/content and integration event contracts remain unchanged.

This is a targeted audit of shared controls and the reachable database/Website workflows. It does not establish that every screen or every UX state in the product has been exhaustively reviewed. Physical devices and manual assistive technology remain separate acceptance gates.

## Wider public-tool follow-up
The reusable UX lab and additional findings UI09–UI16 are documented in QA-TOOLS.md. UI14 includes a distinct source-hydration race: a compact sheet can focus a title before its first server pull, so focus alone must not freeze stale text. Actual edits retain their durable candidate; clean fields follow synchronized source. Growing textareas resize outside ResizeObserver delivery to avoid observer-loop errors. The lab includes a 558-case browser/size/theme plan and repeatable generated sequences; visiting these named states is not exhaustive workflow/device acceptance.

UI16: Complete WCAG A/AA tag coverage exposed visible/accessibility label mismatches on database Filter, active Filter/Sort counts and Props. The full visible strings now supply the accessible names, and Props is spelled out as Properties. Opened-control tests assert the active names. QA01, the omitted level-A tag, and the controlled detector regression are recorded in QA-TOOLS.md.
