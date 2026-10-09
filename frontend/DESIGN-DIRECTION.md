# Design direction 08: dense-pro

A keyboard-first IDE skin for Replot. It treats the browser tab like a desktop IDE: compact chrome, a
command palette as the main way around, an activity bar, breadcrumbs, and a status bar that tells you
everything about the box you are coding in.

## Subject, audience, job

- Subject: a real Linux container you drive from a browser tab.
- Audience for this direction: working developers and serious students who already live in VS Code,
  JetBrains or Zed and want Replot to feel like home in the first five seconds.
- Primary job: open a repl and stay in flow for an hour without touching the mouse.

## Token plan, first draft

| Role | Name | Hex |
| --- | --- | --- |
| Ground (editor, page) | Graphite | `#15181E` |
| Panels | Slate | `#1D2129` |
| Text | Paper | `#DCE1EA` |
| Accent | Mint | `#5BD1A5` |
| Run | Mint | `#5BD1A5` |

Type: JetBrains Mono everywhere; 12px UI.

Layout: VS Code clone, card grid dashboard, centered hero with a big headline and a screenshot.

## Review against the five generated-design clusters

1. Cream, serif, terracotta: not at risk.
2. Near-black with one acid accent: the first draft was exactly this (`#15181E` with one mint). Revised:
   the ground is lifted to a blue graphite (`#1C2029`), and color now comes from a system instead of one
   accent: every language has its own accent, and the chrome takes on the accent of the repl you are in.
   Run gets its own warm signal (amber) so it never competes with the language color.
3. Broadsheet hairlines and zero radius: a dense IDE needs borders, so radius is set by hierarchy
   instead of one value (tiled panes 0, controls 3px, floating surfaces 8px), and lists use fills for
   hover/selection rather than a rule under every row.
4. SaaS card kit: the first draft had a card grid dashboard. Revised to a dense, sortable-looking table
   of repls (one row each, language stripe on the left) with a quick-start strip of templates above it.
5. Template chrome: the first draft used monospace for all UI, which is the "mono for small labels"
   tell. Revised to Red Hat Text for UI and Red Hat Mono only where the content is code (editor,
   terminals, paths, commit hashes, ports). No all-caps section labels (the old "FILES" and
   "VERSION CONTROL" headers become sentence case), no middle-dot meta strings (repl rows use real
   columns), no arrow glyphs appended to buttons.

Centered hero with screenshot was also a default. Revised: the landing hero is a working command
palette. You type a language and press Enter; that is the product's first ten seconds, shown by doing it.

## Final token plan

### Color

| Name | Hex | Use |
| --- | --- | --- |
| Graphite | `#1C2029` | page and editor ground |
| Slate | `#222731` | panels, title bar, sidebars |
| Wire | `#363D4B` | borders between tiles, input outlines |
| Paper | `#DCE1EA` | primary text (12.4:1 on Graphite) |
| Fog | `#939CAD` | secondary text (5.4:1 on Slate, 4.6:1 on hover fill `#2C3240`) |
| Caret | `#82AAFF` | focus ring, selection, links, default accent (7.1:1 on Graphite) |
| Ignition | `#F2B544` | Run button only, dark text `#1A1405` (10:1) |
| Fault | `#F07178` | errors, destructive actions (5.2:1 on Slate) |

Language accents (all tuned to the same lightness so dark text `#14171D` on them is 7:1 or better, and
they read 6:1 or better as text on Slate): Python `#7DAEF0`, JavaScript `#E8CF62`, Node `#8FCB6B`,
TypeScript `#4FC1E9`, Go `#5ED6C4`, Rust `#E39A84`, Java `#F2A65A`, Kotlin `#B79BF5`, C `#A9B4C6`,
C++ `#F290B8`, C# `#7FD49A`, Ruby `#F08A8A`, PHP `#9EA8F0`, Lua `#A7B8FF`, Perl `#6FC2D6`,
Bash `#A6D86E`, Haskell `#C49CE0`, R `#6FA8DC`, Fortran `#B4A6F0`, Pascal `#E3E07A`, NASM `#C9B48A`,
Scheme `#8FB0E8`, Lisp `#6CD3A6`, HTML `#F0956A`.

### Type

- UI: Red Hat Text (variable, @fontsource-variable). Drawn for small sizes, so it holds up at 12-13px.
- Code: Red Hat Mono (variable). Editor, terminals, paths, hashes, ports.
- Display: Red Hat Display, only for the landing headline and page titles.
- One superfamily, three optical roles. Scale: 11 (keycaps) / 12 (status, meta) / 13 (UI base) /
  15 (section titles) / 20 (page titles) / 44 (landing headline). Tabular figures in the status bar.

### Shape, depth, spacing, motion

- Radius by hierarchy: tiled panes 0; controls, tabs, chips 3px; floating surfaces (palette, dialogs,
  menus) 8px.
- Elevation: tiles are flat and separated by Wire borders. Only floating surfaces get a shadow, one
  value: `0 18px 50px -12px rgb(6 8 12 / .7)`.
- Spacing: 4px base. Rows 24px (tree, palette 30px), title bar 38px, tab strip 32px, status bar 24px.
- Motion: only in response to actions. The palette opens in 120ms (opacity + 2% scale); the status bar
  color crossfades over 240ms when you switch to a repl in another language. All of it is disabled by
  `prefers-reduced-motion`.

### Layout

Workspace, desktop:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ‹ ▣ owner / repl-name     [ Search files and commands      Ctrl K ]  ▶ Run  Fork Share ◯ │ 38px title bar
├──┬───────────┬──────────────────────────────────┬──────────────────────────┤
│▤ │ Files     │ main.py ×  utils.py ×            │ Console Shell Web Display│
│⎇ │ ▸ src     │ repl › src › main.py             │                          │
│  │   main.py │                                  │  xterm (Red Hat Mono)    │
│  │           │  Monaco, theme replot-graphite   │                          │
│⌘ │           │                                  │                          │
├──┴───────────┴──────────────────────────────────┴──────────────────────────┤
│ Python ▌ ● Running  ⎇ main  Pyright ready   ⊗ 0  ⚠ 1   Ln 12, Col 4   Ctrl K │ 24px status bar, language-colored
└────────────────────────────────────────────────────────────────────────────┘
```

Workspace, phone (under 768px): one pane at a time. Title bar keeps back, name, palette button and Run.
A dense text tab strip above the status bar switches Files / Code / Console / Shell / Web / Git /
Display. The status bar stays, trimmed to language, container state and problems.

```
┌──────────────────────────┐
│ ‹ repl-name     ⌕   ▶ Run│
├──────────────────────────┤
│ main.py ×                │
│ (active pane fills)      │
│                          │
├──────────────────────────┤
│ Files Code Console Shell…│
│ Python ● Ready   ⊗0 ⚠0   │
└──────────────────────────┘
```

Dashboard: title bar with palette trigger, a quick-start strip of the most used templates (one click to
a named repl), then a dense table. Left aligned throughout.

```
┌──────────────────────────────────────────────────────────┐
│ ▣ Replot  My repls  Explore   [ Search … Ctrl K ]    ◯   │
├──────────────────────────────────────────────────────────┤
│ My repls                                   [New repl  N] │
│ Start from  [Py Python] [Nd Node] [Fl Flask] … All       │
│ Filter [____________]                                    │
│ ▌ name            template     visibility   updated   ⋯  │
│ ▌ name            template     visibility   updated   ⋯  │
│ Shared with me                                           │
├──────────────────────────────────────────────────────────┤
│ status bar: signed in as @you   3 repls   Ctrl K commands │
└──────────────────────────────────────────────────────────┘
```

Landing: left aligned, one column, no feature cards.

```
 ▣ Replot                                    Explore  Log in  [Sign up]

 Type a language.
 Get a Linux box.
 Replot runs your code in a real container, in a browser tab.

 ┌ ⌕ python ─────────────────────────────── Ctrl K ┐
 │ Py  Python          Python 3 with pip         ↵ │
 │ Fl  Flask           Python web server            │
 │ …                                                │
 └──────────────────────────────────────────────────┘
 Console, shell, web preview, GUI display, git and live multiplayer in every repl.
```

### Principles

1. The keyboard is the primary input. Every action in the workspace is in the palette with its
   shortcut shown; the mouse paths still work.
2. Spend color on meaning. The language accent says where you are; amber means Run; red means
   something broke. Nothing else is colored.
3. Density without crowding: 13px UI, 24px rows, but every hit target on touch screens grows to 40px.
4. The memorable thing: the language-keyed status bar. It is the one loud surface. Everything around it
   stays quiet graphite.

## Keyboard map

| Keys | Action |
| --- | --- |
| Ctrl/⌘ K, Ctrl/⌘ Shift P, F1 | Command palette |
| Ctrl/⌘ P | Go to file (palette in file mode) |
| Ctrl/⌘ Enter | Run / Stop (in the editor or anywhere outside a text field) |
| Ctrl/⌘ B | Toggle sidebar |
| Ctrl/⌘ Shift E / Ctrl/⌘ Shift G | Files / Version control |
| Ctrl/⌘ J | Toggle tools pane |
| Ctrl/⌘ S | Save (unchanged) |
| N | New repl (dashboard, outside text fields) |

Tradeoff: Monaco's Ctrl+K chords (Ctrl+K Ctrl+C) are given up for the palette; Ctrl+/ still toggles
comments.

## Critique log

Pass 1 (screenshots at 1440x900 and 390x844):

- The Run button carried a `Ctrl Enter` keycap pair. With the palette trigger's `Ctrl K` next to it, the
  title bar read as a keyboard chart. Removed the accessory: the shortcut moved to Run's tooltip and the
  palette, where it is listed next to the command.
- Template slugs in the repl table were set in mono. That is the "mono for small labels" tell; switched to
  the UI face.
- The create dialog repeated "Python / Python" when a template's name equals its language; the language
  line now only appears when it adds information (Flask, Python). The Public switch label wrapped; it is
  now a label plus one line of help.
- On phones, Run did not bring the console forward when the console was already the selected tool. Run now
  switches the phone view to the output it starts.
- The landing page told touch users to press Ctrl K. That line now hides on coarse pointers.

Pass 2:

- Explore marked every row "viewer", which is true and useless. The role chip is now off on Explore and
  kept on "Shared with me", where viewer vs editor matters.
- JavaScript and Java both abbreviated to "Ja"; JavaScript and TypeScript chips now read JS and TS.
- Primary-button focus ring was caret blue on a caret-blue button. Added a 2px offset in the ground color
  so the ring separates from the fill.
- Console checks: the only remaining browser errors are the logged-out `GET /auth/me` 401s the app
  makes on purpose. Fixed a React ref warning on dialog overlays (forwardRef) and the filter input
  (forwardRef so `/` can focus it).

Known tradeoffs:

- Monaco's Ctrl+K chords are given up to the palette (Ctrl+/ still comments).
- Monaco line numbers (`#6B7486`, 3.4:1) sit below AA on purpose so they recede; all text the user reads
  or acts on is 4.6:1 or better.
- Fonts are bundled (three variable WOFF2 families, latin + latin-ext, about 130 KB total, loaded on use)
  so a self-hosted server never calls out to Google.
