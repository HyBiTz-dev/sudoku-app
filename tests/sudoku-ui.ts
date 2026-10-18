/**
 * Drives the real UI in Chromium: plays a puzzle to completion, checks the
 * win state, conflict highlighting, undo, and reload persistence.
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.SUDOKU_URL ?? "http://localhost:3000";
let failures = 0;
function check(label: string, condition: boolean) {
  if (!condition) {
    failures++;
    console.error(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

async function readGrid(page: Page): Promise<number[]> {
  return page.$$eval('[role="gridcell"]', (cells) =>
    cells.map((cell) => Number((cell.textContent ?? "").trim() || 0))
  );
}

/** Poll until `predicate` holds, so a busy machine cannot flake a fixed sleep. */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeout = 5000
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Resolve `--board-conflict` to the rgb() the browser actually paints. */
async function conflictColour(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--board-conflict)";
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
}

/** True when a cell paints the conflict background. */
function isConflictCell(page: Page, index: number, expected: string): Promise<boolean> {
  return page
    .locator('[role="gridcell"]')
    .nth(index)
    .evaluate((cell, colour) => getComputedStyle(cell).backgroundColor === colour, expected);
}

/**
 * Sample a colour until two reads in a row agree, so a CSS transition is not
 * caught mid-animation.
 */
async function settledColor(target: () => Promise<string>): Promise<string> {
  let previous = "";
  for (let attempt = 0; attempt < 25; attempt++) {
    const current = await target();
    if (current === previous) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return previous;
}

const browser = await chromium.launch();
const page = await browser.newPage();

const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector('[role="gridcell"]');

// 1. The board renders and starts with a workable number of clues.
const initial = await readGrid(page);
check("81 cells rendered", initial.length === 81);
const clueCount = initial.filter((value) => value !== 0).length;
check("clues present", clueCount > 20 && clueCount < 50);
check(
  "game persisted to localStorage",
  Boolean(await page.evaluate(() => window.localStorage.getItem("sudoku:game:v1")))
);
// The footer is gone: the fill count, the clue count and the technique readout
// were all its own, and the keyboard hints have no say on a touch device.
check("no footer is rendered", (await page.locator("footer").count()) === 0);

// 1b. On the stacked layout every key is a filled button, which is what makes it
// read as a tap target rather than as text. Checked here, before the solve empties
// every key, so there is a key with digits still left to look at.
const resolveColour = (variable: string) =>
  page.evaluate((value) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${value})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, variable);
const boardFills = [await resolveColour("--board-surface"), await resolveColour("--board-peer")];
const wideViewport = page.viewportSize();
await page.setViewportSize({ width: 420, height: 900 });
const liveFill = await page
  .locator('button[aria-label$="remaining"]')
  .first()
  .evaluate((key) => getComputedStyle(key).backgroundColor);
const liveText = await page
  .locator('button[aria-label$="remaining"]')
  .first()
  .evaluate((key) => (key as HTMLElement).innerText.trim());
check(`a live stacked key has a fill (${liveFill})`, boardFills.includes(liveFill));
check(`a live stacked key shows its digit (${liveText})`, /^\d\s*\d+$/.test(liveText));
await page.setViewportSize(wideViewport!);

// 2. Placing a digit with the number pad.
const firstEmpty = initial.findIndex((value) => value === 0);
await page.locator('[role="gridcell"]').nth(firstEmpty).click();
await page.getByRole("button", { name: /^5,/ }).click();
check("pad places a digit", (await readGrid(page))[firstEmpty] === 5);
check(
  "pad keeps focus on the board",
  await page.evaluate(() => document.activeElement?.getAttribute("role") === "gridcell")
);

// The key stacks its digit over its remaining count. They have to stay separate
// flex children: nested in one span they become inline and the count rides up
// onto the digit's baseline.
const padLayout = await page.getByRole("button", { name: /^7,/ }).evaluate((key) => {
  const [digitRow, countRow] = [...key.children] as HTMLElement[];
  // Missing rows mean the digit and count got nested into one child, which is the
  // regression this guards. Report it rather than throwing on the null rect.
  if (!digitRow || !countRow) return { stacked: false, centred: false };
  const digit = digitRow.getBoundingClientRect();
  const count = countRow.getBoundingClientRect();
  return {
    stacked: digit.bottom <= count.top + 1,
    centred:
      Math.abs(digit.left + digit.width / 2 - (count.left + count.width / 2)) < 1,
  };
});
check("the pad count sits below its digit, not beside it", padLayout.stacked);
check("the pad count is centred under its digit", padLayout.centred);

// 3. Placing the same digit again clears the cell (toggle).
await page.getByRole("button", { name: /^5,/ }).click();
check("re-placing the same digit clears the cell", (await readGrid(page))[firstEmpty] === 0);

// 4. Keyboard entry and navigation.
await page.keyboard.press("7");
check("keyboard places a digit", (await readGrid(page))[firstEmpty] === 7);
await page.keyboard.press("Backspace");
check("Backspace erases the digit", (await readGrid(page))[firstEmpty] === 0);

// 4. Keyboard entry and navigation. Arrow keys may land on a given, which is
//    correctly uneditable, so walk to the next empty cell before typing.
const focusedLabel = () =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

await page.keyboard.press("ArrowRight");
check(
  "arrow keys move the selection",
  (await focusedLabel()).startsWith(`Row 1 column ${(firstEmpty % 9) + 2}`)
);

// Step back onto the empty cell we started from; givens are uneditable, so
// typing anywhere else would be (correctly) ignored.
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("2");
check("typing places a digit at the selection", (await readGrid(page))[firstEmpty] === 2);
await page.keyboard.press("Backspace");
check("Backspace erases the digit", (await readGrid(page))[firstEmpty] === 0);

// 5. Undo restores the value the cell held before the last move.
await page.locator('[role="gridcell"]').nth(firstEmpty).click();
await page.getByRole("button", { name: /^3,/ }).click();
check("digit placed for the undo test", (await readGrid(page))[firstEmpty] === 3);
await page.getByRole("button", { name: "Undo" }).click();
check("undo reverts the last move", (await readGrid(page))[firstEmpty] === 0);

// 6. Conflicts are flagged. Pick an empty cell that shares a row with a clue,
//    then type the same digit as that clue.
const clueIndex = initial.findIndex((value) => value !== 0);
const clueDigit = initial[clueIndex];
const rowStart = clueIndex - (clueIndex % 9);
let conflictCell = -1;
for (let offset = 0; offset < 9; offset++) {
  const candidate = rowStart + offset;
  if (initial[candidate] === 0 && candidate !== clueIndex) {
    conflictCell = candidate;
    break;
  }
}

await page.locator('[role="gridcell"]').nth(conflictCell).click();
await page.getByRole("button", { name: new RegExp(`^${clueDigit},`) }).click();

const conflictLocator = page.locator('[role="gridcell"]').nth(conflictCell);
check(
  "conflicting digit is placed",
  ((await conflictLocator.textContent()) ?? "").trim() === String(clueDigit)
);

// The wrong cell shows only a red digit; the red background belongs to the
// cells holding that same digit.
check(
  "conflicting cell keeps a clean background",
  !(await conflictLocator.evaluate((cell) => cell.className.includes("destructive")))
);
check(
  "conflicting digit is coloured red",
  await waitUntil(() =>
    conflictLocator
      .locator("span")
      .first()
      .evaluate((span) => getComputedStyle(span).color === "rgb(214, 69, 69)")
  )
);

const conflictColourValue = await conflictColour(page);
check(
  "the existing cell with that digit is flagged",
  await waitUntil(() => isConflictCell(page, clueIndex, conflictColourValue))
);

await page.keyboard.press("Backspace");
check(
  "flags clear when the conflict is removed",
  await waitUntil(async () => !(await isConflictCell(page, clueIndex, conflictColourValue)))
);

// 7. Solve the whole puzzle through the UI.
await page.evaluate(async () => {
  const saved = JSON.parse(window.localStorage.getItem("sudoku:game:v1") ?? "null");
  const cells = [...document.querySelectorAll('[role="gridcell"]')] as HTMLElement[];
  const buttons = [...document.querySelectorAll("button")];
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  for (let index = 0; index < cells.length; index++) {
    if (saved.puzzle[index] !== 0) continue;

    const digit = saved.solution[index];
    cells[index].click();
    await nextFrame();

    const pad = buttons.find((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith(`${digit},`)
    );
    pad?.click();
    await nextFrame();
  }
});

await page.waitForSelector("text=Solved.", { timeout: 5000 }).catch(() => null);
const solvedGrid = await readGrid(page);
check("every cell is filled", solvedGrid.every((value) => value !== 0));

// Winning opens an alert dialog rather than a banner on the board, and the
// dialog is modal, so nothing underneath it is reachable while it is up.
const winDialog = page.locator('[role="alertdialog"]');
check("solving the board opens a prompt", (await winDialog.count()) === 1);
check(
  "the win prompt reports the tier and how it went",
  // Either wording: the solver below walks the board past the point where the
  // game finishes it for the player, so this usually lands on the second.
  /Medium with \d+ clues, (solved in \d+ moves|all but finished)/.test(
    (await winDialog.textContent()) ?? ""
  )
);
check(
  "the win prompt offers another game or keeps the board",
  (await page.getByRole("button", { name: "Keep board" }).count()) === 1 &&
    (await page.getByRole("button", { name: "New game" }).count()) === 1
);
check(
  "no win banner is left on the board",
  (await page.locator("main >> text=Solved.").count()) === 0
);

// Cancelling has to leave the finished board exactly as it was.
await page.getByRole("button", { name: "Keep board" }).click();
check(
  "keeping the board closes the prompt",
  await waitUntil(async () => (await winDialog.count()) === 0)
);
check(
  "keeping the board leaves every cell filled",
  (await readGrid(page)).every((value) => value !== 0)
);
check(
  "no conflicts remain",
  !(await page.locator('[role="gridcell"].text-destructive').count())
);

// With every cell filled all nine digits are spent, so on the desktop layout each
// pad key shows a tick instead of its digit, and each key reads "complete".
const padKeys = page.locator('button[aria-label$="remaining"], button[aria-label$="complete"]');
const padTickCount = await padKeys.locator("svg.lucide-check").count();
check(
  `a completed digit shows a tick on the pad (${padTickCount}/9)`,
  padTickCount === 9
);
check(
  "a completed pad key is labelled complete",
  (await page.getByRole("button", { name: /, complete$/ }).count()) === 9
);

// A finished key keeps the pad's surface fill, so the 3x3 block has no hole in it.
// The pointer is still over a pad key after the solver ran, which paints the hover
// tint, so accept the resting fill or the hover one.
const surfaceFills = boardFills;
check(
  "a completed pad key keeps its surface fill",
  // Poll: the pointer is resting on a pad key, so the hover tint may still be
  // transitioning when this runs.
  await waitUntil(async () => {
    const fill = await page
      .getByRole("button", { name: /, complete$/ })
      .first()
      .evaluate((key) => getComputedStyle(key).backgroundColor);
    return surfaceFills.includes(fill);
  })
);

// The stacked keypad keeps no tick and no spent digit: a key still in play is a
// filled button, and one whose digit is used up is blank, fill included, while
// holding its place in the row.
const desktopViewport = page.viewportSize();
await page.setViewportSize({ width: 420, height: 900 });
// Every digit is used up on a solved board, so this key is the spent case.
const spentKeyBox = await padKeys
  .first()
  .evaluate((key) => ({
    // `textContent` counts hidden nodes, so read `innerText`, which reflects
    // what is actually painted.
    text: (key as HTMLElement).innerText.trim(),
    height: key.getBoundingClientRect().height,
  }));
check(
  "the tick is hidden on the stacked keypad",
  !(await padKeys.first().locator("svg.lucide-check").isVisible().catch(() => false))
);
check(
  `a spent key is blank on the stacked keypad (${spentKeyBox.text})`,
  spentKeyBox.text === ""
);
// The fill transitions, so poll: straight after the resize it is still the
// desktop colour on its way out.
const spentFill = () =>
  page
    .locator('button[aria-label$="complete"]')
    .first()
    .evaluate((key) => getComputedStyle(key).backgroundColor);
const spentKeyWentClear = await waitUntil(async () => (await spentFill()) === "rgba(0, 0, 0, 0)");
check(
  `a spent key drops its fill on the stacked keypad (${await spentFill()})`,
  spentKeyWentClear
);
// A blank key still has to sit in the row, so the others do not shift.
check(
  `a blank stacked key keeps its place in the row (${spentKeyBox.height}px)`,
  spentKeyBox.height > 0
);
await page.setViewportSize(desktopViewport!);

// 8. Reload resumes the same finished game. The board is still solved on load, so
// the win prompt comes back with it and has to be put away before anything else.
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[role="gridcell"]');
const afterReload = await readGrid(page);
check(
  "reload resumes the finished board",
  afterReload.every((value, index) => value === solvedGrid[index])
);
check(
  "a reload into a solved board prompts again",
  await waitUntil(async () => (await winDialog.count()) === 1)
);
await page.getByRole("button", { name: "Keep board" }).click();
await waitUntil(async () => (await winDialog.count()) === 0);

// 9. A new game resets the board.
await page.getByRole("button", { name: "New game" }).click();
await waitUntil(async () => {
  const solved = await winDialog.count();
  const grid = await readGrid(page);
  return solved === 0 && grid.some((value) => value === 0);
});
const afterNewGame = await readGrid(page);
check("new game clears user entries", afterNewGame.some((value) => value === 0));
check("new game keeps a full set of clues", afterNewGame.filter(Boolean).length >= 20);

// 10. Difficulty selection produces a puzzle with the right clue count. Asking for
// a tier opens a prompt, so the switch only happens once it is confirmed.
const boardBeforeSwitch = (await readGrid(page)).join("");
await page.getByRole("button", { name: "Expert" }).click();
check(
  "asking for another tier opens a prompt",
  await waitUntil(async () => (await winDialog.count()) === 1)
);
check(
  "the tier prompt names the tier it would switch to",
  /Switch to Expert/.test((await winDialog.textContent()) ?? "")
);
check(
  "the tier prompt leaves the board alone while it is open",
  (await readGrid(page)).join("") === boardBeforeSwitch
);
await page.getByRole("button", { name: "Keep playing" }).click();
check(
  "cancelling the switch closes the prompt",
  await waitUntil(async () => (await winDialog.count()) === 0)
);
check(
  "cancelling the switch keeps the current tier",
  (await page.getByRole("button", { name: "Expert" }).getAttribute("aria-pressed")) ===
    "false"
);
check(
  "cancelling the switch keeps the board",
  (await readGrid(page)).join("") === boardBeforeSwitch
);

await page.getByRole("button", { name: "Expert" }).click();
await page.getByRole("button", { name: "Switch tier" }).click();
check(
  "confirming the switch closes the prompt",
  await waitUntil(async () => (await winDialog.count()) === 0)
);
check(
  "confirming the switch marks the new tier as current",
  (await page.getByRole("button", { name: "Expert" }).getAttribute("aria-pressed")) ===
    "true"
);
await page.getByRole("button", { name: "New game" }).click();
await waitUntil(async () => (await readGrid(page)).filter(Boolean).length <= 32);
const expertGrid = await readGrid(page);
const expertClues = expertGrid.filter(Boolean).length;
check(`expert puzzle is sparse (${expertClues} clues)`, expertClues <= 32);

// The tier already in play is not a change, so it must not prompt.
await page.getByRole("button", { name: "Expert" }).click();
check(
  "re-picking the current tier does not prompt",
  (await winDialog.count()) === 0
);

// Start a fresh board and wait for it: the save lags the click by an effect, so
// reading storage too early hands back the previous game.
const startFreshGame = async () => {
  await page.getByRole("button", { name: "New game" }).click();
  await waitUntil(async () => {
    const puzzle = await page.evaluate(
      () => JSON.parse(window.localStorage.getItem("sudoku:game:v1")!).puzzle as number[]
    );
    const grid = await readGrid(page);
    // The reset board holds nothing but its clues.
    return grid.every((value, index) => value === puzzle[index]);
  });
};

// 11. The game finishes the board once it is all but done. Play the whole thing
// correctly and the last cells arrive by themselves.
await startFreshGame();

/**
 * Fill every cell that is still empty with the digit it wants, reading the live
 * DOM each step rather than a snapshot: partway through, the game finishes the
 * board itself and the cells after that are already correct. Those clicks are
 * dispatched in the page because the win prompt that appears is modal, and a
 * real click would retry against the backdrop instead of moving on to the next
 * cell.
 */
const fillRemainingCorrectly = async (skip = -1) => {
  await page.evaluate(
    ({ leave }) => {
      const buttons = [...document.querySelectorAll("button")];
      const nextFrame = () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      return (async () => {
        const g = JSON.parse(localStorage.getItem("sudoku:game:v1")!);
        const cells = [...document.querySelectorAll('[role="gridcell"]')] as HTMLElement[];
        for (let index = 0; index < cells.length; index++) {
          if (g.puzzle[index] !== 0 || index === leave) continue;
          const shown = (cells[index].textContent ?? "").trim();
          // Already right, whether placed by hand or filled in by the game, or
          // holding something else: either way there is nothing to do here.
          if (shown !== "" && shown !== String(g.solution[index])) continue;
          if (shown === String(g.solution[index])) continue;
          cells[index].click();
          await nextFrame();
          buttons
            .find(
              (button) =>
                (button.getAttribute("aria-label") ?? "").startsWith(`${g.solution[index]},`)
            )
            ?.click();
          await nextFrame();
        }
      })();
    },
    { leave: skip }
  );
};

await fillRemainingCorrectly();
check(
  "the board fills itself in once it is nearly done",
  (await readGrid(page)).every((value) => value !== 0)
);
check(
  "the win prompt says the game finished it",
  /filled in for you/.test((await winDialog.textContent()) ?? "")
);

// One undo takes the whole assist back, not one cell of it.
await page.getByRole("button", { name: "Keep board" }).click();
await waitUntil(async () => (await winDialog.count()) === 0);
const beforeUndo = (await readGrid(page)).filter(Boolean).length;
await page.getByRole("button", { name: "Undo" }).click();
await waitUntil(async () => (await readGrid(page)).some((value) => value === 0));
const afterUndo = (await readGrid(page)).filter(Boolean).length;
check(
  `one undo takes back every cell the game filled (${beforeUndo} -> ${afterUndo})`,
  afterUndo < beforeUndo && afterUndo > 0
);
check(
  "undoing the assist does not win the board again",
  (await winDialog.count()) === 0
);

// A board with a mistake in it is never finished for the player. Filling empty
// cells cannot rescue a wrong entry, and quietly doing it would hide the mistake
// instead of showing it.
await startFreshGame();
// A cell the board wants a different digit in, so putting `mistaken` there is a
// wrong entry. The cell left over at the end is one whose digit the mistake does
// not touch, so the pad still has that digit to give: whatever stays empty there
// was left empty by the game on purpose.
const target = await page.evaluate(() => {
  const g = JSON.parse(window.localStorage.getItem("sudoku:game:v1")!);
  const empty = (index: number) => g.puzzle[index] === 0 && g.values[index] === 0;
  const cell = g.puzzle.findIndex((_: number, index: number) => empty(index));
  const mistaken = (g.solution[cell] % 9) + 1;
  const spare = g.puzzle.findIndex(
    (value: number, index: number) => empty(index) && index !== cell && g.solution[index] !== mistaken
  );
  return { cell, mistaken, spare };
});
await page.locator('[role="gridcell"]').nth(target.cell).click();
await page.keyboard.press(String(target.mistaken));
await fillRemainingCorrectly(target.spare);

const afterBlocked = await page.evaluate((cell) => {
  const g = JSON.parse(window.localStorage.getItem("sudoku:game:v1")!);
  return {
    solved: g.values.every((value: number, index: number) => value === g.solution[index]),
    mistake: g.values[cell],
  };
}, target.cell);
check(
  "a board that is nearly full but wrong is not finished for the player",
  (await winDialog.count()) === 0 && !afterBlocked.solved
);
check(
  "the game leaves the last cell alone rather than filling it over the mistake",
  (await readGrid(page))[target.spare] === 0
);
check(
  "the game leaves the wrong entry alone instead of papering over it",
  afterBlocked.mistake === target.mistaken
);
// A wrong digit is coloured, not its cell, so compare the glyph's colour against
// the resolved `--board-wrong`.
const wrongColour = await page.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.color = "var(--board-wrong)";
  document.body.appendChild(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
});
check(
  "the wrong entry on a nearly full board is still flagged",
  await waitUntil(() =>
    page
      .locator('[role="gridcell"]')
      .nth(target.cell)
      .locator("span")
      .first()
      .evaluate((span, want) => getComputedStyle(span).color === want, wrongColour)
  )
);

// 12. Notes. The board above is all but full, so start over properly — the later
// sections look for empty cells to work in.
await startFreshGame();

check(
  "no timer, mistake, or hint features remain",
  (await page.locator("text=Mistakes").count()) === 0 &&
    (await page.locator("text=Time").count()) === 0 &&
    (await page.getByRole("button", { name: /timer/ }).count()) === 0 &&
    (await page.getByRole("button", { name: /^Hint/ }).count()) === 0
);

// A digit that contradicts the unique solution is flagged red.
const saved = await page.evaluate(() => {
  const game = JSON.parse(window.localStorage.getItem("sudoku:game:v1")!);
  return { puzzle: game.puzzle, solution: game.solution, values: game.values } as {
    puzzle: number[];
    solution: number[];
    values: number[];
  };
});

let wrongCell = -1;
let wrongDigit = 1;
for (let index = 0; index < 81; index++) {
  if (saved.puzzle[index] !== 0 || saved.values[index] !== 0) continue;
  const candidate = (saved.solution[index] % 9) + 1;
  wrongCell = index;
  wrongDigit = candidate;
  break;
}
await page.locator('[role="gridcell"]').nth(wrongCell).click();
await page.getByRole("button", { name: new RegExp(`^${wrongDigit},`) }).click();

const wrongLocator = page.locator('[role="gridcell"]').nth(wrongCell);
check(
  "wrong digit turns red on its own cell",
  await waitUntil(() =>
    wrongLocator
      .locator("span")
      .first()
      .evaluate((span) => getComputedStyle(span).color !== getComputedStyle(document.body).color)
  )
);
check(
  "wrong cell keeps a clean background",
  await waitUntil(() =>
    wrongLocator.evaluate((cell) => !cell.className.includes("destructive"))
  )
);

// No selection ring on any cell: the selection is shown by its background.
// Check the rendered box-shadow, not a class name, since every cell carries
// `focus-visible:ring-*` in its base classes.
const ringOf = (index: number) =>
  page
    .locator('[role="gridcell"]')
    .nth(index)
    .evaluate((cell) => getComputedStyle(cell).boxShadow);

const focusShadow = () =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active?.matches('[role="gridcell"]')) return "not-a-cell";
    const cs = getComputedStyle(active);
    return `${cs.boxShadow}|${cs.outlineStyle}`;
  });

check("filled selected cell has no ring", (await ringOf(wrongCell)) === "none");

const emptySelected = await page.evaluate((skip) => {
  const g = JSON.parse(localStorage.getItem("sudoku:game:v1")!);
  return g.puzzle.findIndex((value: number, index: number) => value === 0 && index !== skip);
}, wrongCell);
await page.locator('[role="gridcell"]').nth(emptySelected).click();
check("empty selected cell has no ring either", (await ringOf(emptySelected)) === "none");

// Keyboard navigation must not reintroduce a ring either: `:focus-visible`
// only fires on the keyboard path, which is where a stray outline showed up.
await page.keyboard.press("ArrowRight");
await page.keyboard.press("5");
check(
  "keyboard navigation and entry add no ring",
  await waitUntil(async () => (await focusShadow()) === "none|none")
);

// The selected cell must still be identifiable with the ring gone.
check(
  "selected cell stays distinguishable by background",
  await waitUntil(() =>
    page.evaluate(() => {
      const cells = [...document.querySelectorAll('[role="gridcell"]')] as HTMLElement[];
      const index = cells.findIndex((cell) => cell.getAttribute("aria-selected") === "true");
      if (index === -1) return false;
      const selected = getComputedStyle(cells[index]).backgroundColor;
      return cells.some((cell, i) => {
        if (i === index) return false;
        const value = (cell.textContent ?? "").trim();
        return (
          value === "" &&
          Math.floor(i / 9) !== Math.floor(index / 9) &&
          i % 9 !== index % 9 &&
          getComputedStyle(cell).backgroundColor !== selected
        );
      });
    })
  )
);

// Twins are only flagged when they share a row or column with the wrong cell:
// that is where the duplicate actually breaks the rules.
const twinScope = await page.evaluate(
  ({ digit, skip }) => {
    const cells = [...document.querySelectorAll('[role="gridcell"]')];
    const texts = cells.map((cell) => (cell.textContent ?? "").trim());
    const wrongRow = Math.floor(skip / 9);
    const wrongCol = skip % 9;
    const sameDigit = (index: number) => index !== skip && texts[index] === String(digit);

    return {
      inRow: texts.findIndex(
        (text, index) => sameDigit(index) && Math.floor(index / 9) === wrongRow
      ),
      inColumn: texts.findIndex(
        (text, index) => sameDigit(index) && index % 9 === wrongCol
      ),
      inBox: texts.findIndex((text, index) => {
        if (!sameDigit(index)) return false;
        const r = Math.floor(index / 9), c = index % 9;
        return (
          Math.floor(r / 3) === Math.floor(wrongRow / 3) &&
          Math.floor(c / 3) === Math.floor(wrongCol / 3)
        );
      }),
      elsewhere: texts.findIndex(
        (text, index) =>
          sameDigit(index) &&
          Math.floor(index / 9) !== wrongRow &&
          index % 9 !== wrongCol &&
          Math.floor(Math.floor(index / 9) / 3) !== Math.floor(wrongRow / 3)
      ),
    };
  },
  { digit: wrongDigit, skip: wrongCell }
);

const colour = await conflictColour(page);
check(
  `same digit in the same row is flagged (${wrongDigit})`,
  twinScope.inRow === -1 || (await waitUntil(() => isConflictCell(page, twinScope.inRow, colour)))
);
check(
  `same digit in the same column is flagged (${wrongDigit})`,
  twinScope.inColumn === -1 ||
    (await waitUntil(() => isConflictCell(page, twinScope.inColumn, colour)))
);
check(
  `same digit in the same box is flagged (${wrongDigit})`,
  twinScope.inBox === -1 || (await waitUntil(() => isConflictCell(page, twinScope.inBox, colour)))
);

// The cell that must stay clean can only be judged once the twins above have
// finished painting. Cells carry `transition-colors`, so a `getComputedStyle`
// read taken straight after the placement catches a background still in flight,
// and a twin that reads as clean looks like a twin wrongly left unflagged.
const locatedTwins = [twinScope.inRow, twinScope.inColumn, twinScope.inBox].filter(
  (index) => index >= 0
);
const twinsSettled = () =>
  page.evaluate(
    ({ indices, want }) => {
      const cells = document.querySelectorAll('[role="gridcell"]');
      return indices.every(
        (index: number) => getComputedStyle(cells[index]).backgroundColor === want
      );
    },
    { indices: locatedTwins, want: colour }
  );
check(
  "the conflict highlight settles before the clean-cell check",
  locatedTwins.length === 0 || (await waitUntil(twinsSettled))
);
check(
  `same digit outside the row, column and box is not flagged (${wrongDigit})`,
  twinScope.elsewhere === -1 || !(await isConflictCell(page, twinScope.elsewhere, colour))
);

// Notes mode pencils a mark into an empty cell rather than committing a digit.
// Marks only render in empty cells, so this needs a genuinely blank one.
await page.getByRole("button", { name: /Notes/ }).click();
const latest = await page.evaluate(() => {
  const game = JSON.parse(window.localStorage.getItem("sudoku:game:v1")!);
  return { puzzle: game.puzzle, values: game.values } as { puzzle: number[]; values: number[] };
});
const noteCell = latest.puzzle.findIndex(
  (value, index) => value === 0 && latest.values[index] === 0
);
await page.locator('[role="gridcell"]').nth(noteCell).click();
await page.keyboard.press("4");
// Measuring the spread needs at least two marks, so pencil in two more.
await page.keyboard.press("2");
await page.keyboard.press("6");
const noteCellLocator = page.locator('[role="gridcell"]').nth(noteCell);
// The cell text is the run of pencil marks, so check the committed value via
// the accessible name instead of scraping digits.
check(
  "notes mode does not place a digit",
  ((await noteCellLocator.getAttribute("aria-label")) ?? "").endsWith("empty")
);
check(
  "notes mode shows the pencil mark",
  await waitUntil(async () => ((await noteCellLocator.textContent()) ?? "").includes("4"))
);

// The notes button states its mode with a badge, not just a colour: ON on the
// solid brand fill, OFF back on the surface wash. Notes mode is on here, so read
// that state first, then toggle out and back to cover both.
// The fills the notes button is expected to paint: the brand blue it switches on,
// and the idle wash. The idle button has two valid fills — its resting surface
// and the peer tint it takes on hover — and the pointer is still over it after a
// click, so accept either rather than pinning the resting one.
const notesButtonFill = await page.evaluate(() => {
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const resolve = (value: string) => {
    probe.style.backgroundColor = value;
    return getComputedStyle(probe).backgroundColor;
  };
  const fill = {
    idle: [resolve("var(--board-surface)"), resolve("var(--board-peer)")],
    on: resolve("var(--brand)"),
  };
  probe.remove();
  return fill;
});

const notesButton = page.getByRole("button", { name: /Notes/ });
const notesState = () =>
  notesButton.evaluate((node) => ({
    badge: node.textContent?.trim() ?? "",
    fill: getComputedStyle(node).backgroundColor,
    radius: Number.parseFloat(getComputedStyle(node).borderRadius),
  }));

/** Poll the fill until it reaches `wanted`, since the colour transitions. */
const fillReaches = (wanted: string[]) =>
  waitUntil(async () => wanted.includes((await notesState()).fill));

check(
  "notes button reads ON while in notes mode",
  (await notesState()).badge === "ON"
);
const notesOn = await notesState();
check(
  "notes button fills with the brand blue while active",
  await fillReaches([notesButtonFill.on])
);

await notesButton.click();
await waitUntil(async () => (await notesState()).badge === "OFF");
const notesOff = await notesState();
check(
  "notes button drops the blue fill while inactive",
  await fillReaches(notesButtonFill.idle)
);
check(
  "notes button stays fully rounded in both states",
  notesOff.radius === notesOn.radius && notesOn.radius > 0
);
await notesButton.click(); // back to notes entry for the rest of this section
await waitUntil(async () => (await notesState()).badge === "ON");

// The marks should fill the cell, not huddle in the middle.
// The marks container should fill the cell rather than huddle in the middle.
// Measure the container, not the span between the first and last mark: that
// depends on which digits happen to be pencilled in.
const noteLayout = await noteCellLocator.evaluate((cell) => {
  const grid = cell.querySelector("span") as HTMLElement;
  const cellBox = cell.getBoundingClientRect();
  const gridBox = grid.getBoundingClientRect();
  return {
    fillX: gridBox.width / cellBox.width,
    fillY: gridBox.height / cellBox.height,
    clipped: grid.scrollWidth > grid.clientWidth || grid.scrollHeight > grid.clientHeight,
  };
});
check(
  `pencil marks fill the cell (${Math.round(noteLayout.fillX * 100)}% x ${Math.round(noteLayout.fillY * 100)}%)`,
  noteLayout.fillX > 0.9 && noteLayout.fillY > 0.9
);
check("pencil marks are not clipped", !noteLayout.clipped);

// Each mark should sit in the middle of its third of the cell, not hug the top
// of it. Measured with a Range so the stretched element box is not mistaken for
// the glyph itself.
const noteCentring = await noteCellLocator.evaluate((cell) => {
  const grid = cell.querySelector("span") as HTMLElement;
  const marks = [...grid.querySelectorAll("span")] as HTMLElement[];
  const glyphBox = (element: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect();
  };
  const gridBox = grid.getBoundingClientRect();
  const rowHeight = gridBox.height / 3;

  const offsets = marks
    .map((mark, index) => ({ mark, row: Math.floor(index / 3) }))
    .filter(({ mark }) => (mark.textContent ?? "").trim() !== "")
    .map(({ mark, row }) => {
      const glyph = glyphBox(mark);
      const trackCentre = gridBox.top + rowHeight * (row + 0.5);
      return Math.abs(glyph.top + glyph.height / 2 - trackCentre);
    });

  return offsets.length ? Math.max(...offsets) : 0;
});
check(
  `pencil marks are centred in their rows (worst offset ${noteCentring.toFixed(1)}px)`,
  noteCentring < 1.5
);

// Committing a digit clears that digit's pencil mark in the cell itself.
await page.getByRole("button", { name: /Notes/ }).click(); // back to placing
await page.locator('[role="gridcell"]').nth(noteCell).click();
await page.keyboard.press("4");
await waitUntil(async () => (await readGrid(page))[noteCell] === 4);

const marksIn = (index: number) =>
  page.evaluate((cell) => {
    const mask = JSON.parse(localStorage.getItem("sudoku:game:v1")!).notes[cell];
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => mask & (1 << d)).join("");
  }, index);

const marksAfterPlace = await marksIn(noteCell);
check(
  `only the placed digit's pencil mark is removed (left: ${marksAfterPlace})`,
  marksAfterPlace === "26"
);

// Erasing the digit brings the surviving marks back, minus the committed one.
await page.keyboard.press("Backspace");
const marksAfterErase = await marksIn(noteCell);
check(
  `erasing restores the remaining marks only (${marksAfterErase})`,
  marksAfterErase === "26"
);

// A cell sharing a row, column, or box that pencilled the same digit loses it
// too, while a cell sharing no unit with the origin keeps it.
const noteScope = await page.evaluate((origin) => {
  const g = JSON.parse(localStorage.getItem("sudoku:game:v1")!);
  const row = Math.floor(origin / 9);
  const col = origin % 9;
  const box = Math.floor(row / 3) * 3 + Math.floor(col / 3);
  const shares = (index: number, kind: "row" | "col" | "box") =>
    kind === "row"
      ? Math.floor(index / 9) === row
      : kind === "col"
        ? index % 9 === col
        : Math.floor(Math.floor(index / 9) / 3) * 3 +
              Math.floor((index % 9) / 3) ===
            box;
  const find = (test: (index: number) => boolean) =>
    g.puzzle.findIndex(
      (value: number, index: number) =>
        value === 0 && index !== origin && test(index)
    );
  return {
    sameRow: find((index) => shares(index, "row")),
    sameCol: find((index) => shares(index, "col")),
    sameBox: find((index) => shares(index, "box")),
    elsewhere: find(
      (index) =>
        !shares(index, "row") && !shares(index, "col") && !shares(index, "box")
    ),
  };
}, noteCell);

const unitPeers = [noteScope.sameRow, noteScope.sameCol, noteScope.sameBox];

await page.getByRole("button", { name: /Notes/ }).click();
for (const cell of [...unitPeers, noteScope.elsewhere]) {
  if (cell < 0) continue;
  await page.locator('[role="gridcell"]').nth(cell).click();
  await page.keyboard.press("3");
}
// Commit 3 in the origin cell.
await page.getByRole("button", { name: /Notes/ }).click();
await page.locator('[role="gridcell"]').nth(noteCell).click();
await page.keyboard.press("3");

for (const [label, cell] of [
  ["row", noteScope.sameRow],
  ["column", noteScope.sameCol],
  ["box", noteScope.sameBox],
] as const) {
  check(
    `the same digit's mark is cleared across the ${label}`,
    cell < 0 || (await waitUntil(async () => (await marksIn(cell)) === ""))
  );
}
check(
  "the same digit's mark survives where no unit is shared",
  noteScope.elsewhere < 0 || (await marksIn(noteScope.elsewhere)) === "3"
);
await page.getByRole("button", { name: /Notes/ }).click();

// 12. A digit spent on a wrong placement is used up, not finished. Start from a
// fresh board so the counts are predictable, then drive one digit to all nine
// copies with a single wrong placement among them.
await page.getByRole("button", { name: "New game" }).click();
await waitUntil(async () => {
  const puzzle = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("sudoku:game:v1")!).puzzle as number[]
  );
  const grid = await readGrid(page);
  // The reset board holds nothing but its clues.
  return grid.every((value, index) => value === puzzle[index]);
});
const plan = await page.evaluate(() => {
  const g = JSON.parse(window.localStorage.getItem("sudoku:game:v1")!);
  const empty = (index: number) => g.puzzle[index] === 0;
  // The digit with the fewest givens needs the fewest placements to reach nine.
  const digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((best, d) =>
    g.values.filter((v: number) => v === d).length <
    g.values.filter((v: number) => v === best).length
      ? d
      : best
  );
  const givens = g.values.filter((v: number) => v === digit).length;
  // Nine copies fill the digit, the givens already count, and one of the rest is
  // the wrong one, so nine minus the givens minus that one.
  const correct = g.puzzle
    .map((_: number, index: number) => index)
    .filter((index: number) => empty(index) && g.solution[index] === digit)
    .slice(0, 8 - givens);
  // A cell the digit does not belong in, so the last placement is a wrong one.
  const wrong = g.puzzle.findIndex(
    (value: number, index: number) => empty(index) && g.solution[index] !== digit
  );
  return { digit, correct, wrong };
});

const spentKey = page.getByRole("button", { name: new RegExp(`^${plan.digit},`) });
const place = async (cell: number, digit: number) => {
  await page.locator('[role="gridcell"]').nth(cell).click();
  await page.keyboard.press(String(digit));
};
// Every copy in the right place first, so the ninth lands in the wrong one.
for (const cell of plan.correct) await place(cell, plan.digit);
await place(plan.wrong, plan.digit);
check(
  `a digit placed nine times over is spent (${await spentKey.getAttribute("aria-label")})`,
  (await spentKey.getAttribute("aria-label")) === `${plan.digit}, 0 remaining`
);
check(
  "a spent digit with a wrong placement shows no tick",
  (await spentKey.locator("svg.lucide-check").count()) === 0
);
check(
  "a spent digit with a wrong placement is not labelled complete",
  (await spentKey.getAttribute("aria-label")) !== `${plan.digit}, complete`
);

// Correcting that entry leaves the digit one short, so the key goes back to an
// ordinary one rather than flipping to complete.
const rightDigit = await page.evaluate(
  (index: number) =>
    JSON.parse(window.localStorage.getItem("sudoku:game:v1")!).solution[index],
  plan.wrong
);
await place(plan.wrong, rightDigit);
await waitUntil(
  async () =>
    (await spentKey.getAttribute("aria-label")) === `${plan.digit}, 1 remaining`
);
check(
  "correcting the entry restores the digit's remaining count",
  (await spentKey.getAttribute("aria-label")) === `${plan.digit}, 1 remaining`
);
check(
  "a corrected but incomplete digit shows no tick",
  (await spentKey.locator("svg.lucide-check").count()) === 0
);

// 13. Theme toggle.
const htmlClass = () => page.evaluate(() => document.documentElement.className);
const lightBefore = await htmlClass();

await page.getByRole("button", { name: "Toggle theme" }).click();
check(
  "toggle switches to the dark theme",
  await waitUntil(async () => {
    const value = await htmlClass();
    return lightBefore !== value && value.includes("dark");
  })
);

// Compare the page background, which depends only on the theme. A cell's colour
// would move legitimately across a reload: the selection resets to the first
// empty cell, so the peer highlights shift with it.
const bodyBackground = () =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const darkPage = await settledColor(bodyBackground);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[role="gridcell"]');
check("theme survives a reload", (await htmlClass()).includes("dark"));
check(
  "page keeps its dark background after reload",
  (await settledColor(bodyBackground)) === darkPage
);

await page.getByRole("button", { name: "Toggle theme" }).click();
check(
  "toggle switches back to the light theme",
  await waitUntil(async () => (await htmlClass()).includes("light"))
);

check("no page errors", errors.length === 0);
if (errors.length) console.error(errors.slice(0, 5).join("\n"));

await browser.close();
console.log(failures === 0 ? "\nAll UI checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);