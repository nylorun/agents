---
version: alpha
name: Nylorun Studio
description: "The operator's console for a Nylorun Tenant. shadcn/ui on the Nova style and the Zinc base color, in Nylorun's brand, with zinc and white everywhere and Sage greens only in charts, Space Grotesk, DM Sans and JetBrains Mono."
colors:
  primary: "#09090b"
  primary-foreground: "#ffffff"
  background: "#ffffff"
  foreground: "#09090b"
  muted: "#f4f4f5"
  muted-foreground: "#71717a"
  border: "#e4e4e7"
  ring: "#a1a1aa"
  destructive: "#09090b"
  chart-1: "#111d13"
  chart-2: "#415d43"
  chart-3: "#7da182"
  chart-4: "#cde0d0"
  chart-5: "#f2f8f2"
typography:
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
  title-sm:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
  body-md:
    fontFamily: DM Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: DM Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  label-md:
    fontFamily: DM Sans
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.54
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.08em
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  row-height: 40px
  toolbar-height: 56px
  sidebar-width: 256px
  panel-width: 448px
  panel-wide-width: 672px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  table-head:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label-md}"
    height: 36px
  table-row:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    height: "{spacing.row-height}"
  table-row-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  table-row-selected:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  tab-indicator:
    backgroundColor: "{colors.primary}"
    height: 2px
  chart-series-1:
    backgroundColor: "{colors.chart-2}"
  chart-series-2:
    backgroundColor: "{colors.chart-3}"
  chart-series-3:
    backgroundColor: "{colors.chart-4}"
  chart-series-4:
    backgroundColor: "{colors.chart-1}"
  chart-single:
    backgroundColor: "{colors.chart-2}"
  chart-track:
    backgroundColor: "{colors.chart-5}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.ring}"
    width: 1px
  status-attention:
    backgroundColor: "{colors.foreground}"
    rounded: "{rounded.full}"
    size: 6px
  status-running:
    backgroundColor: "{colors.muted-foreground}"
    rounded: "{rounded.full}"
    size: 6px
  status-idle:
    backgroundColor: "{colors.ring}"
    rounded: "{rounded.full}"
    size: 6px
---

## Overview

Studio is where an operator watches and steers a Tenant's Agents. It should read like a well-kept terminal session turned into a table: quiet, dense, exact, and fast to scan. The reference is the Unix `ls -l` listing, not a marketing dashboard: one line per thing, columns that line up, nothing decorative.

Studio is built on **shadcn/ui** and takes its components as they are. The preset is: Radix, the **Nova** style (reduced padding, for compact interfaces), the **Zinc** base color with no accent theme, **Lucide** icons and the default radius. Its colors are Nylorun's own, from the brand's Design.md, and there is no color outside charts: shadcn's components, text and state are **zinc and white**, and charts and graphs take one hue, **Sage**: five greens from forest to mist. Its type is Nylorun's own, as on nylorun.com and docs.nylorun.com: **Space Grotesk** for headings, **DM Sans** for text, **JetBrains Mono** for code, ids and metadata. This file adds only what shadcn does not decide: how pages are laid out, how state is shown, and what to avoid.

## Colors

Nylorun's brand palette, split in two. Everything but charts is zinc and white, with shadcn's variable names (`primary` is `--primary`): components, text, errors and state. Charts and graphs, and only they, take color: the Sage scale, five greens from forest to mist. Nothing else is red, green or amber.

- **Background (#ffffff) and foreground (#09090b):** the ground and all primary text.
- **Primary (#09090b):** the one filled button on a view and the active tab's underline. Text on it is primary-foreground (#ffffff).
- **Muted (#f4f4f5) and muted-foreground (#71717a):** a hovered or selected row, the active sidebar item, an active filter; secondary text such as column heads, timestamps, notes and inactive tabs; the running status dot and the · separator.
- **Border (#e4e4e7):** every hairline. **Ring (#a1a1aa):** focus outlines, with shadcn's 3px halo, an active filter's border, and the idle status dot.
- **Destructive (#09090b):** shadcn's `--destructive`, set to the foreground. A delete button looks like the primary one, and its label and the confirm dialog say what it does; an error message is foreground text that says what failed.
- **Chart-1 to chart-5, the Sage scale:** one hue in five steps, so a chart reads as one calm accent beside the zinc. Series take chart-2 (#415d43), chart-3 (#7da182) and chart-4 (#cde0d0) in that order, forest to mist, then chart-1 (#111d13) for a fourth, and never skip one; a color follows its series, so a filter never repaints the others. A single series, such as a budget's used bar or artifact sizes, takes chart-2 (`chart-single`), the first series' color. A session's tokens by kind: cached input chart-2, uncached input chart-3, output chart-4, and cache writes, which only some providers report, chart-1. Chart-5 (#f2f8f2) is never a series: it is the track behind a bar or meter and the band behind a range (`chart-track`). A fifth series folds into "Other" in ring (#a1a1aa). Use them in charts and graphs only, never on a component, a status dot, in text, or on the logo. A meter, such as a budget nearing its limit, stays chart-2; its number says how close it is.

Series differ in lightness, not hue: neighbors are at least 20.9 ΔE apart, for color-blind readers too. Chart-3 and chart-4 are light on white (2.9:1 and 1.4:1), so a chart always carries a legend or labels, and a series is never told apart by color alone. Stacked fills keep a 1px white gap between segments. shadcn's `card`, `popover`, `secondary`, `accent`, `input` and `sidebar` variables keep their Zinc values.

## Typography

Nylorun's three faces, each kept to its role as the brand's Design.md sets them:

- **Space Grotesk** (display) for headings only: one `headline-md` per page as its title, `headline-lg` on a page with no table, `title-sm` over a section or a side panel. Never in a table, a control or running text.
- **DM Sans** (text) for everything an operator reads and operates: table cells and controls in `body-md`, column heads in `label-md` in muted-foreground, hints and notes in `body-sm`.
- **JetBrains Mono** (mono) for what the system names and for metadata: Agent and session ids, manifest names, hosts, images and keys in `mono-md`; group rows and eyebrows in `label-caps`, uppercase.

Weights are 400 for text and 600 for headings; avoid 700. Digits in columns use tabular figures. Don't reach for a one-off size: use the scale.

## Layout

The app is a 256px sidebar and a full-width main area under a 56px header bar. A page is a header (title, a state badge, one line of facts), then one row of underline tabs, then one table with a 56px toolbar above it. Tables run edge to edge; the only inset is the 16px gutter at the start of every toolbar, cell and header. Rows are one line, 40px high: long text ends in an ellipsis and shows in full on hover. A row's detail or a form opens in a 448px side panel on the right; a file, payload or spec to read opens in a 672px one (`panel-wide-width`). A list you keep browsing opens its detail in a pane beside it.

## Elevation & Depth

Flat. Hierarchy comes from hairline borders and the muted fill, not shadows. Only what floats over the page is lifted, using shadcn's own shadows: menus and the side panel (over a 50% black scrim). Never put a shadow or a card around a table.

## Shapes

shadcn's default radius (0.625rem): `md` (8px) for buttons, inputs and menus, `lg` (10px) for a bordered block such as an empty state, `sm` (6px) for chips, `full` for badges and status dots. Tables, toolbars, tabs and panels have square edges.

## Components

Use shadcn/ui components unchanged, with Lucide icons at 16px:

- **Button:** `default` (primary) for the one main action on a view, `outline` for secondary actions, `ghost` for icon buttons and inside rows, `destructive` only to confirm a delete. Labels are verbs in sentence case; end with "…" when the button opens a panel or a confirm.
- **Table:** shadcn's Table with single-line rows. The first column is the thing's id or name, the last a ghost ⋯ button that opens a DropdownMenu. Destructive menu items come last, after a separator.
- **Tabs:** one row of underline tabs per page, ordered by how the work flows. No counts, no icons, no tabs inside a tab.
- **Sheet:** the side panel, from the right: 448px for one row's detail or a form, 672px for a file, payload or spec to read.
- **Badge:** outline, holding a status dot and the state's word. A count of things waiting on a person is a `default` (zinc) badge.
- **DropdownMenu:** filters ("Status: Any") and ⋯ actions.
- **Sidebar:** shadcn's Sidebar: the brand, the Tenant, then the Agents with their status dots.

A status is a 6px dot followed by its word in foreground, and the word carries the meaning. The dot's shade says how much it needs you: foreground for failed or waiting on a person (`status-attention`), muted-foreground for running or healthy (`status-running`), ring for idle or stopped (`status-idle`).

## Do's and Don'ts

- Do keep every table row to one line, and open detail on the right, never inline.
- Do use one primary button per view, and put everything else in a ⋯ menu.
- Do write counts as "3 sessions", or "1 of 3 sessions" when filters hide some.
- Don't use color for state, errors or destructive actions; don't use the chart colors outside charts and graphs; and don't add colors beyond this file and shadcn's Zinc base.
- Don't show warning banners for normal states; a dot and a word in the row is enough.
- Don't use emoji, gradients or custom components where a shadcn component exists.
