# Replot, direction 04: Fjord ("quiet daylight")

## Subject, audience, job

Replot is a browser IDE with a real Linux container behind every repl. The people using it are students
on school laptops, hobbyists, and developers sketching ideas on a phone. The two jobs are getting from
"I want to try X" to running code in seconds, and then staying comfortable in the workspace for an hour.

Fjord treats that hour as the product. Most IDE skins compete for attention; this one stays out of the
way. The look comes from Nordic daylight on still water: cool overcast light, slate rock, deep fjord
water and grey-green lichen. Dusk is the same landscape after the sun goes down, not an inverted copy.

## Token plan (final)

### Color

| Name    | Daylight  | Dusk      | Role |
|---------|-----------|-----------|------|
| Frost   | `#E8EDEF` | `#161E23` | Page ground, gaps between panes |
| Snow    | `#F7F9F9` | `#1E272D` | Sheets: panes, editor, dialogs, list rows |
| Mist    | `#DDE5E8` | `#2A353C` | Hover, selected rows, inputs, borders (as tone, not hairlines) |
| Slate   | `#2E3D45` | `#D6DFE3` | Text |
| Shale   | `#53656E` | `#93A4AD` | Secondary text (AA on Frost, Snow and Mist) |
| Fjord   | `#2D6177` | `#8DBBD0` | Primary actions, links, focus ring, selection |
| Lichen  | `#56692F` | `#A7BC79` | Reserved for Run and live state (container ready, process running) |
| Lingon  | `#A23C3C` | `#E28B83` | Destructive and error |

Lichen is the only green-yellow in the UI, so the eye goes to Run and the live dot without either being loud.
Measured contrast: Slate/Frost 9.5, Shale/Frost 5.2, Shale/Mist 4.8, white on Fjord 6.8, white on Lichen 6.1;
dusk text 11.5, dusk Shale 6.1, ink on dusk Fjord 7.5.

### Type

- **Schibsted Grotesk** (variable, @fontsource-variable, self-hosted): every UI and display role. It was drawn
  for a Norwegian news group, so it fits the subject, and it has a firm, slightly narrow build that suits
  dense tool UI. Display: 56/60, weight 500, tracking -0.02em. Headings 24/30 weight 600. Body 15/24.
  UI 13–14. No all-caps labels anywhere.
- **Fragment Mono** (@fontsource, self-hosted): code only, meaning the editor, the console, shell, diff,
  commit SHAs and URLs. It isn't used for small UI labels.
- Self-hosted on purpose: Replot is self-hosted software and should work on an air-gapped box.

### Shape, elevation, spacing

- Radii follow hierarchy, never one value everywhere: page sheets and dialogs 18px, workspace panes 14px,
  controls 8px, chips and menu rows 6px, status dots round.
- Elevation is tone first: Snow sheets sit on a Frost ground separated by 6–8px gaps, so panes read as
  islands without borders. Only floating layers (menus, dialogs, popovers) get a shadow, and that shadow
  is tinted with slate blue (`0 18px 40px -18px rgb(30 52 64 / .35)`) instead of neutral grey.
- Spacing is generous outside the workspace (a 4px base with 24/40/72 rhythm) and compact inside it.

### Motion

- One orchestrated moment: the landing reflection settles once on load. It starts blurred and resolves
  over 1.4s, like water going still.
- Everything else moves only in response to input: dialogs, menus, focus mode.
- `prefers-reduced-motion` turns all of that off, including spinners slowing to static.

### Layout

Left-aligned throughout (a reading edge you can trust). Centered text only in empty states.

Landing:
```
Replot                                        Explore   Log in  [Sign up]

A quiet place to write
and run code.                               (56px, weight 500, flush left)
Pick a language and get a real Linux computer...
[Start coding]  Browse public repls

┌ main.py ───────────────────────────────┐┌ Console ─────────┐
│ def greet(name): ...                   ││ > god morgen, Ada│
└────────────────────────────────────────┘└──────────────────┘
══════════════════ waterline ════════════════════════════════════
  (same block mirrored, soft, fading into Frost)

What comes with every repl      A real Linux box ......  Web preview ......
(two-column definition list)    Desktop apps ..........  Work together ....

Start with a language
Python  Node.js  Go  Rust  C  ...      (wrapping list of quiet links, colored dots)
```

Dashboard / Explore: a single list instead of a card grid. Each row is a full-width Snow strip with the
language tile, name, template, updated time and visibility in fixed columns; rows are separated by 4px of
Frost. On phones the columns fold under the name.
```
Your repls                                           [New repl]
┌───────────────────────────────────────────────────────────────┐
│ [Py] brave-otter-12      Python      2h ago    Public     ⋯  │
└───────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────┐
│ [Fl] flask-site          Flask       just now  Private    ⋯  │
└───────────────────────────────────────────────────────────────┘
Shared with you
...
```

Workspace (desktop): panes are three Snow islands on Frost with rounded corners and 6px gutters; the
resize handles live in the gutters.
```
[<] [P] brave-otter-12  ● Ready      [ ▶ Run ]        [Focus] [Fork] [Share] [◐] (A)
╭ Files | Git ─╮ ╭ main.py  utils.py ───────────╮ ╭ Console Shell Web Display ╮
│ main.py      │ │ 1  def greet(name):          │ │ > god morgen              │
│ utils.py     │ │ 2      return ...            │ │                           │
╰──────────────╯ ╰ Pyright  ✕0 ⚠0 ──────────────╯ ╰───────────────────────────╯
```
Focus mode (button or Ctrl/Cmd+Shift+F): the file and tool panes collapse, the top bar
loses everything except back, name, Run and the exit control, and the editor sits on Frost with wide
margins. Pressing Run in focus mode leaves focus mode so the output is visible.

Workspace (phone, under 768px): one pane at a time, with a bottom bar for Files, Code, Console, Shell,
Web and Display. Run stays in the top bar, within thumb reach on the right. All panes stay mounted, so
sockets and terminal history survive switching.

### Principles

1. Calm is a feature. Reserve saturation for the two things that matter: what you can do (Fjord) and what
   is alive (Lichen).
2. Hierarchy by tone and radius, not by lines and shadows.
3. Say what it is. Plain sentence-case copy. No eyebrows, no middle-dot meta strings, no arrow glyphs on buttons.
4. Dusk is designed, not inverted: same names, re-tuned values, its own Monaco and terminal theme.

## Review against the five generated-design clusters

First draft, then what changed:

1. *Cream + serif + terracotta.* The first draft had no cream, but its ground was `#F1F3F1`, a warm
   off-white. **Changed** to a cool, slightly blue Frost `#E8EDEF` so the daylight reads overcast and
   northern, not paper. No serif, no clay accent.
2. *Near-black + one acid accent.* Dusk was first drafted as `#111418` with a bright cyan. **Changed** to a
   blue-slate night (`#161E23`/`#1E272D`) with desaturated Fjord and Lichen, so it stays low-contrast-but-AA.
3. *Broadsheet hairlines, zero radius.* The base shadcn kit separates everything with 1px borders. **Changed**
   to tonal islands with gutters; borders survive only on inputs and as dialog edges.
4. *SaaS card kit.* The first draft kept the card grid for repls and for landing features. **Changed:**
   repls are a list of rows, features are a two-column definition list, languages are inline links. Radii
   vary by hierarchy (18/14/8/6), and the only shadow is the blue-tinted one on floating layers.
5. *Template chrome.* The existing UI had all-caps "FILES" headers, all-caps template category labels,
   `@owner · template · 2h ago` meta strings, and an arrow on "Start coding". **Changed:** sentence-case
   section names, meta split into separate aligned columns, no arrow glyphs. Mono is limited to code.

The first draft's generic part was the primary color: a mid "SaaS blue" `#2F6FED` that any IDE skin would
pick. **Revised** to the deeper, greener Fjord `#2D6177`. Run moved off the primary color onto Lichen, which
gives the one action that matters its own color.

## Memorable thing

**The waterline.** The landing hero is a real-looking repl (editor and console) resting on a horizon,
with its mirror image fading into the water below. It shows the product doing its job, puts the subject's
still water on screen, and is the only decorative device in the system. The logo mark repeats it as a
letter P with its reflection. Everything else is kept quiet.

## Critique passes (screenshots)

Pass 1 (1440 daylight):
- The headline broke onto three lines and left "code." on its own line, with dead space on the right.
  Widened the measure to 18ch and tightened the hero padding. The headline now sets in two lines, and the
  reflection starts inside the first 900px viewport, where the memorable thing has to be.
- The footer repeated "Browse public repls" a third time. Removed it (the accessory that came off).
- In the daylight Monaco theme, keywords (`#2D6177`) were too close in lightness to Slate text. Moved them
  to `#1D6A8F` (5.7:1 on Snow), which keeps them in the fjord family but makes them read as keywords.
- Monaco's overview-ruler cursor tick showed as a stray dash in the top-right corner. Turned it off.

Pass 2 (390 + dusk):
- On phones the workspace opened on Console instead of Code. StrictMode's double effect defeated a
  "skip first run" guard. Replaced it with a sequence counter on `setToolTab`. That also fixed Run on a
  phone not revealing the console when the console was already the selected tool tab.
- The "Live" collaboration pill sat on top of line 1 at phone width. Moved it to the bottom-right
  corner of the editor.
- Focus rings were 3px at 50% Fjord, too faint on Frost. Buttons now get a solid 2px Fjord ring with a 2px
  offset; inputs and tabs use 70%.
- Fragment Mono's tiny Cyrillic subsets were being inlined into the CSS as base64 (+12 kB gzip). Now only
  the latin and latin-ext subsets are imported.

Known tradeoffs: the Run button centers in the space left between the two header groups, so it shifts
a little with name length and in focus mode. The 6-tab phone bar trades label length for reach (Webview
becomes "Web").
