# Sudoku

A 9×9 sudoku game built with Next.js 16 (App Router), React 19, Tailwind v4, and
shadcn/ui. Generation and solving run entirely in the browser — there is no
backend, and no network request happens after the page loads.

## Getting started

```bash
bun install
bun run dev
```

Then open <http://localhost:3000>.

## Playing

Click a cell or use the arrow keys, then type `1`–`9` to place a digit and
`Backspace` to clear it. Placing the digit already in a cell clears it again.
`Ctrl`+`Home` / `Ctrl`+`End` jump to the first and last cell.

There is no footer. It used to carry the fill count, the clue count, the hardest
technique and the keyboard hints; none of that earned its place, and the hints
had no say on a touch device anyway.

Two things that throw work away ask first, both as alert dialogs — a dialog that
has to be answered, so the board underneath stays put and a stray click on the
backdrop changes nothing:

- **Finishing the game** opens a prompt with the tier, the clue count and the
  move count, offering another game or keeping the finished board. It replaces
  what used to be a win banner: the only thing left to do once the board is full
  is start another game, which is exactly the decision worth asking about. The
  prompt opens once per game, and reappears after a reload, since a solved board
  in storage is still a solved board.
- **Switching tier** opens a prompt before anything moves, because a tier change
  replaces the game in play. Picking the tier you are already on is not a
  change and does not prompt.

The header's **New game** button is left as the quick, unprompted restart it
was, so there is always one way to start over without a dialog in the way.

## Auto-completing a board that is all but done

Once the board is at least 90% correct, the game fills the last cells in for you
and wins it. The clues count towards that total, so a medium puzzle starts around
45% and has to be carried most of the way before this can happen — it finishes a
board that was nearly solved, not one that merely looks full.

**A board with a mistake in it is never finished this way.** Filling empty cells
cannot rescue a wrong entry, so the only thing it could achieve is hiding the
mistake behind a full board. Those boards are already lost, and they are left for
the player to see.

The check runs inside the placement that can cross the threshold, not in an
effect. That keeps it to one state update — a render, a check, and a second
update is exactly what `react-hooks/set-state-in-effect` warns about — and it
means the assist and the move that triggered it land together.

`Move` grew an optional `fills` list for this. The game writes several cells in
one go, and recording them as one move keeps a single undo taking the whole
assist back out, rather than making the player undo it cell by cell. The win
prompt says the board was finished rather than solved when the last move carries
one.

The toolbar above the keypad holds undo, erase, and notes:

- **Notes** (pencil) switches entry into pencil-mark mode. The button carries an
  `ON`/`OFF` badge so the mode is readable without relying on its colour, and it
  fills with the solid brand blue while on. Marks appear as small
  candidates inside an empty cell, never in a filled one. Pressing it again
  returns to normal entry. The mark grid stretches to fill the cell edge to edge
  (`h-full w-full`), and its digits are sized in `cqw` against the cell so they
  scale with the board rather than only changing at Tailwind's breakpoints.
  `place-items-center` centres each mark inside its third of the cell; the
  default `stretch` would leave the glyph sitting at the top of its track.
  Committing a digit retires that digit's pencil mark in the placed cell and in
  every cell sharing its **row, column, or box** — the three units where the
  digit can no longer go, so a candidate sitting in one of them has been
  resolved. Every other mark is left alone: the rest of the reasoning is still
  valid. Toggling the digit back off is not a commit, so it leaves the marks
  untouched, and erasing a committed digit keeps them too. Erasing an empty
  cell clears its marks outright.

A digit that contradicts the unique solution is flagged two ways: its own digit
turns red on a clean background, and every cell **in the same row, column, or
box** holding that same digit gets a red background. Those three units are
exactly where a duplicate breaks the rules, so an identical digit elsewhere on
the board is left alone. Both highlights clear as soon as the wrong entry is
changed or erased.

Selected cells carry no ring on either input path. The selection is shown by its
background (`--board-selected`) plus the peer tint, and that reads identically
whether you arrive by mouse or by keyboard. `focus-visible` styling is
deliberately absent: it only fires on the keyboard path, which made a blue
outline appear during keyboard play but not when tapping the keypad.

That background is set as an **inline style**, not a `bg-*` class. Tailwind
emits background utilities in its own stylesheet order, so a class-based
conflict colour loses to `bg-board-match` and `bg-board-selected` for every twin
in the selected cell's row or column — which is exactly the set of cells the
highlight exists to catch. An inline value always outranks a class.

Progress is written to `localStorage` after every move, so a reload resumes the
same puzzle with the same entries, notes, and undo history. The payload
is validated on read, so an outdated or corrupt save falls back to a new puzzle
instead of crashing.

## How it works

```
lib/sudoku/engine.ts       grid helpers, solver, hole digging
lib/sudoku/difficulty.ts   technique analysis
lib/sudoku/generate.ts     difficulty presets, puzzle generation
components/sudoku/         board, number pad, toolbar, game state
components/ui/             button and alert dialog primitives
components/theme-*.tsx     light/dark toggle and provider
```

**Generation** starts from a random complete grid, then removes cells in
randomised pairs (keeping 180° rotational symmetry). Every removal is validated
by counting solutions and rejected unless exactly one remains, so a puzzle can
never be ambiguous or unsolvable. The whole thing runs in a few milliseconds.

**The solver** is backtracking over 9-bit masks with an MRV heuristic: each step
fills the empty cell with the fewest candidates. It is fast enough to check
uniqueness after every removal, which is what makes generation instant.

**Difficulty** is defined by the number of clues (45 / 38 / 32 / 26), which is
what a player actually feels. Separately, `difficulty.ts` replays the puzzle
using only human techniques — naked singles, hidden singles, naked pairs, and
box-line reasoning — and reports the hardest one required. The generator keeps
that analysis on the puzzle. It is deliberately *not* the difficulty tier:
digging holes at random almost always leaves a puzzle that singles can finish,
so tiering by technique would call nearly everything easy. Nothing renders it —
the footer that used to show it is gone — but generation still pays for it, and
the engine tests cover it.

**Progress** is written to `localStorage` after every move, so a reload resumes
the same puzzle with the same entries and undo history. The payload is
validated on read, so an outdated or corrupt save falls back to a new puzzle
instead of crashing.

## Layout

The board's edge length is set once as a CSS variable on the board row:

```css
[--board:min(calc(100dvh_-_15rem),calc((100%_-_1.5rem)/1.7))]
```

It is capped by the viewport height so the grid needs no scrolling, and divided
by 1.7 so the board plus a 70%-sized keypad both fit the row. The keypad column
is `calc(var(--board)*0.7)` wide and holds an `aspect-square` block, which makes
its 3×3 keys square. Sizing both from the same expression avoids a circular
dependency — a percentage height depends on a width that depends on it, and
Chrome resolves that to nonsense.

On small screens the keypad collapses to a single row of keys under the board.

Each key is a filled button at every width. The stacked layout used to show bare
digits, which read as text rather than as tap targets. Each one shows how many
copies of that digit are still unplaced.

A digit that is used up empties its key. On the desktop layout a finished digit
swaps to a tick instead — the `lg` breakpoint, not a media query in JS, so it
costs nothing at render. A key's label becomes `complete` rather than
`0 remaining`, which reads better and keeps the "remaining" pattern free for
keys still in play. In the stacked row there is no room for a tick, so a used-up
key just goes blank: a leftover digit at 30% only adds noise to nine keys, and
the blank still holds its place in the row.

**Counting to nine is not the same as being finished.** The two are separate
states, and the pad needs the wrong-cell set to tell them apart: a digit whose
ninth placement lands in a cell the solution disagrees with is *spent* — the key
stays disabled, since there is nowhere left to put it — but it is not
*complete*, so on the desktop layout it shows no tick and keeps its count.
Otherwise a single bad entry at the end would earn a key that says the digit is
done. The pad takes `wrongCells` from the same set that drives the red digits on
the board.

## Fonts

Google Sans is loaded from Google's CDN by a `<link rel="stylesheet">` in
`app/layout.tsx`, with `preconnect` hints for both hosts. Two notes on why:

- **A remote `@import url(...)` in `globals.css` does not work here.** It is
  stripped by the build — the emitted CSS contains no `@import` at all — so the
  font silently never loads. A `<link>` avoids that and also skips the
  serialised `@import` chain, which blocks rendering on every stylesheet behind it.
- **There is no generated fallback.** `next/font` builds a metric-adjusted
  fallback face to prevent layout shift; a CDN link cannot. So `--font-sans`
  carries an explicit stack (`"Google Sans", ui-sans-serif, system-ui, …`).
  Without it the page renders in Times while the font loads.

There is no second webfont. Geist Mono came from `next/font/google` for the
`<kbd>` elements in the footer, and with the footer gone nothing on the page is
monospace — `--font-mono` is a plain system stack. One font request instead of
two, and one less thing to wait for before the board settles.

## Theming

`next-themes` adds a light/dark toggle in the header. It defaults to the
visitor's system preference, stores the choice, and applies the theme before
hydration so there is no flash of the wrong colours.

The board palette lives as CSS variables on `:root` and `.dark`, mapped to
Tailwind utilities with `@theme inline`, so one set of utilities
(`bg-board-cell`, `text-board-entered`, …) resolves per theme. Dark mode inverts
the palette to deep navy while keeping the blue identity: cells `#1b2540`,
entered digits `#7aa2ff`, givens `#c3cee3`.

Light mode uses white cells with grey hairlines (`#b3bfd0`) and navy box rules —
white-on-white would hide the grid. The hairline sits at 1.86:1 against the cell,
enough to trace the 9×9 without competing with the box rules. Dark mode inverts
the same relationship (`#36466d` lines on `#1b2540` cells, 1.63:1). Toolbar keys
and keypad buttons use a separate `--board-surface` tint, since they sit off the
board and would otherwise disappear against the near-white page.

Each cell draws only its **right** and **bottom** border, so an interior line is
painted once instead of twice. Giving every cell a full border doubles each
shared edge and makes the whole grid look twice as heavy. Measured result:
1px hairlines, 2px box rules, in both themes.

The toggle renders both icons and lets the `dark:` variant decide which shows,
rather than reading the theme into state. Server and client markup stay
identical, so there is no hydration mismatch.

## Installable and offline

The app is a PWA: it installs to the home screen and keeps playing with no
network. Chrome reports zero installability errors.

- `app/manifest.ts` — name, icons, `standalone` display, scope.
- `public/sw.js` — the service worker.
- `components/pwa/` — registration and the install prompt.
- `scripts/generate-icons.mjs` — regenerates the icons (`bun run icons`).

The icons are generated, not hand-drawn, from a 3×3 board in the brand blue
(`#2a55d4`). Two sets: a rounded plate, and a full-bleed **maskable** variant
whose art sits inside the inner 80% safe zone, because Android crops maskable
icons to a circle, a squircle or a teardrop and a tighter grid loses its corners.

The worker serves the app shell network-first and falls back to the cached
shell, so a cold offline start works. Hashed chunks under `/_next/static` are
content-addressed and therefore safe to cache indefinitely, so they are served
cache-first.

Two details that are load-bearing:

- **The chunks are warmed at install time, not just on the second visit.** They
  are requested during the very first load, before the worker is installed and
  controlling the page, so runtime caching alone would leave a first visit with
  nothing to serve offline. `warmCaches` pulls the URLs out of the rendered
  HTML. Turbopack emits them twice — absolute in the tags, relative inside the
  build manifest — so both forms are matched.
- **Fonts are intercepted only once they are cached.** A worker cannot always
  reach a third-party host, and intercepting a request it then fails to perform
  turns a stylesheet the browser would have loaded into a failed one. So
  `cachedFontUrls` gates the interception and anything unknown is left to the
  browser. Offline, Google Sans may be missed and `--font-sans` falls back to
  the system stack.

Registration is skipped outside production: in dev the asset URLs are not
content-hashed, so cache-first would serve stale modules and break hot
reloading. Verify offline against `next build && next start`.

## Tests

```bash
bun run test      # engine: generation, solving, uniqueness, ratings
bun run lint
bunx tsc --noEmit
```

There is also an end-to-end test that drives the real UI in Chromium — placing
digits, undo, error highlighting, notes, solving the board, and reload
persistence:

```bash
bun run dev       # in another terminal
bun run test:ui
```