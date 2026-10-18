"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBackdrop,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogPortal,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { Board, type BoardHandle } from "@/components/sudoku/board";
import { NumberPad } from "@/components/sudoku/number-pad";
import { Toolbar } from "@/components/sudoku/toolbar";
import {
  isSolved,
  CELL_COUNT,
  PEERS,
  type Grid,
} from "@/lib/sudoku/engine";
import {
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  generatePuzzle,
  type Difficulty,
} from "@/lib/sudoku/generate";

const STORAGE_KEY = "sudoku:game:v1";

/** Shared sizing for the two prompt buttons, which sit side by side. */
const PROMPT_BUTTON = "font-semibold";

/**
 * Share of the board that has to be correct before the game finishes it for the
 * player. The clues count towards the total, so a medium puzzle starts around
 * 45% and has to be carried most of the way before this fires.
 */
const AUTO_COMPLETE_AT = 0.9;

/** One entry per move so undo can replay it backwards. */
interface Move {
  index: number;
  from: number;
  to: number;
  /**
   * The other cells the same move wrote. The auto-complete fills the leftovers in
   * one go, and this keeps that a single undo step instead of one per cell.
   */
  fills?: number[];
}

interface Game {
  puzzle: Grid;
  solution: Grid;
  values: Grid;
  /** Pencil marks: one 9-bit mask per cell. */
  notes: number[];
  difficulty: Difficulty;
  moves: Move[];
}

function setAt(grid: Grid, index: number, value: number): Grid {
  const next = grid.slice();
  next[index] = value;
  return next;
}

/**
 * Fill in the rest of the board once it is all but finished, or return null when
 * it is not eligible.
 *
 * Two conditions, and both matter. The board has to be at least
 * `AUTO_COMPLETE_AT` correct, so this finishes a puzzle that was nearly solved
 * rather than one that merely looks full. And nothing on it may be wrong: filling
 * empty cells cannot rescue a wrong entry, so a board with a mistake in it is
 * already lost, and quietly filling the rest would paper over that rather than
 * report it.
 */
function finishBoard(game: Game, values: Grid): { values: Grid; moves: Move[] } | null {
  if (isSolved(values)) return null;

  let correct = 0;
  for (let index = 0; index < CELL_COUNT; index++) {
    const value = values[index];
    if (value === 0) continue;
    if (value !== game.solution[index]) return null;
    correct++;
  }
  if (correct / CELL_COUNT < AUTO_COMPLETE_AT) return null;

  // Only the cells the player left empty. Clues and the player's own entries are
  // correct by the check above, and stay as they are.
  const empties: number[] = [];
  for (let index = 0; index < CELL_COUNT; index++) {
    if (game.puzzle[index] === 0 && values[index] === 0) empties.push(index);
  }
  if (empties.length === 0) return null;

  const filled = values.slice();
  for (const index of empties) filled[index] = game.solution[index];

  return {
    values: filled,
    // One move for the whole batch, so a single undo walks the assist back out
    // instead of making the player undo it cell by cell.
    moves: [
      {
        index: empties[0],
        from: 0,
        to: game.solution[empties[0]],
        fills: empties.slice(1),
      },
    ],
  };
}

/**
 * Drop a digit's pencil mark from `index` and from all 20 cells that share a
 * row, column, or box with it. Those three units are exactly where the digit can
 * no longer be placed, so a candidate in any of them has been resolved.
 */
function clearBit(notes: number[], index: number, bit: number): number[] {
  const next = notes.slice();
  next[index] &= ~bit;
  for (const peer of PEERS[index]) next[peer] &= ~bit;
  return next;
}

function createGame(difficulty: Difficulty): Game {
  const generated = generatePuzzle({ difficulty });
  return {
    puzzle: generated.puzzle,
    solution: generated.solution,
    values: generated.puzzle.slice(),
    notes: new Array<number>(CELL_COUNT).fill(0),
    difficulty: generated.difficulty,
    moves: [],
  };
}

function isGrid(value: unknown): value is Grid {
  return (
    Array.isArray(value) &&
    value.length === CELL_COUNT &&
    value.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 9)
  );
}

function firstEmptyCell(puzzle: Grid): number {
  const index = puzzle.findIndex((value) => value === 0);
  return index === -1 ? 0 : index;
}

/** Read a saved game, rejecting anything that does not match the current shape. */
/** A move the player could legally have made: a cell that is not a given. */
function isValidMove(move: Move, puzzle: Grid): boolean {
  const editable = (index: unknown) =>
    typeof index === "number" && index >= 0 && index < CELL_COUNT && puzzle[index] === 0;

  if (!editable(move?.index)) return false;
  if (move.fills === undefined) return true;
  return Array.isArray(move.fills) && move.fills.every(editable);
}

function parseGame(raw: string | null): Game | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const { puzzle, solution, values, notes, difficulty, moves } =
      parsed as Partial<Game>;

    if (!isGrid(puzzle) || !isGrid(solution) || !isGrid(values)) return null;
    if (!DIFFICULTIES.includes(difficulty as Difficulty)) return null;
    if (!Array.isArray(moves)) return null;

    // Givens are never editable, so restore them on top of whatever was saved.
    const restored = values.map((value, index) => puzzle[index] || value);

    return {
      puzzle,
      solution,
      values: restored,
      notes: Array.isArray(notes) && notes.length === CELL_COUNT ? notes : new Array(CELL_COUNT).fill(0),
      difficulty: difficulty as Difficulty,
      moves: moves.filter((move: Move) => isValidMove(move, puzzle)),
    };
  } catch {
    // Corrupt or outdated payload: start fresh instead of crashing.
    return null;
  }
}

function saveGame(game: Game) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
  } catch {
    // Private mode or a full quota: the game still works in memory.
  }
}

// The game in localStorage is the source of truth on load. `getSnapshot` must
// return a cached reference — returning a freshly parsed object each call would
// make React think the store changed on every render. The first visit has
// nothing stored, so one puzzle is generated and held for the session.
let snapshotCache: { raw: string | null; game: Game } | null = null;

function readGameSnapshot(): Game {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked outright (private mode, disabled cookies).
    raw = null;
  }

  if (snapshotCache && snapshotCache.raw === raw) return snapshotCache.game;

  const stored = raw ? parseGame(raw) : null;
  const game = stored ?? (snapshotCache?.game ?? createGame("medium"));
  snapshotCache = { raw, game };
  return game;
}

// The server has no storage and cannot generate a puzzle without making the
// route request-time dynamic, so it renders the loading state instead. The
// client takes over on the first render after hydration.
function getServerGameSnapshot(): null {
  return null;
}

function subscribeToStorage() {
  return () => {};
}

export function SudokuGame() {
  const [liveGame, setLiveGame] = useState<Game | null>(null);
  const [chosenDifficulty, setChosenDifficulty] = useState<Difficulty | null>(null);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [notesMode, setNotesMode] = useState(false);
  const boardRef = useRef<BoardHandle>(null);

  const snapshotGame = useSyncExternalStore(
    subscribeToStorage,
    readGameSnapshot,
    getServerGameSnapshot
  );

  // `liveGame` takes over as soon as the player moves; before that, the game
  // read from storage (or the one generated for this session) is what we show.
  const game = liveGame ?? snapshotGame;
  const difficulty = chosenDifficulty ?? game?.difficulty ?? "medium";
  const selected = selectedCell ?? (game ? firstEmptyCell(game.puzzle) : null);

  const solved = useMemo(() => (game ? isSolved(game.values) : false), [game]);

  // A wrong digit is one that contradicts the unique solution. Duplicates are
  // flagged too, but they only matter because they are usually the reason the
  // digit was wrong in the first place.
  const errors = useMemo(() => {
    if (!game) return new Set<number>();
    const wrong = new Set<number>();
    for (let index = 0; index < CELL_COUNT; index++) {
      const value = game.values[index];
      if (value && value !== game.solution[index]) wrong.add(index);
    }
    return wrong;
  }, [game]);

  /**
   * Cells holding a digit that another cell got wrong, within the same row,
   * column, or box — the three units a duplicate actually breaks. The wrong
   * cell itself is excluded when the colour is applied, so it keeps a clean
   * background and only its digit turns red.
   */
  const duplicateDigits = useMemo(() => {
    const flagged = new Set<number>();
    if (!game || errors.size === 0) return flagged;

    for (const index of errors) {
      const digit = game.values[index];
      if (!digit) continue;

      for (const peer of PEERS[index]) {
        if (game.values[peer] === digit) flagged.add(peer);
      }
    }
    return flagged;
  }, [game, errors]);

  // Persist whenever the puzzle state changes.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!game) return;
    const signature = JSON.stringify([
      game.puzzle,
      game.values,
      game.notes,
      game.moves.length,
    ]);
    if (signature === lastSaved.current) return;
    lastSaved.current = signature;
    saveGame(game);
  }, [game]);

  /**
   * Apply an edit to the game on screen. The first edit after load has to seed
   * `liveGame` from the stored snapshot, since it is null until then.
   */
  const updateGame = useCallback(
    (edit: (current: Game) => Game) => {
      setLiveGame((previous) => {
        const current = previous ?? snapshotGame;
        // Only null before the store snapshot arrives, when there is no game.
        return current ? edit(current) : current;
      });
    },
    [snapshotGame]
  );

  const startNewGame = useCallback((nextDifficulty: Difficulty) => {
    setChosenDifficulty(nextDifficulty);
    setSelectedCell(null);
    setNotesMode(false);
    setLiveGame(createGame(nextDifficulty));
  }, []);

  /**
   * Two prompts, both about throwing work away. `pendingDifficulty` holds the
   * tier the player asked for but has not confirmed yet; the win prompt has
   * nothing to hold, because it always starts another game on the tier the one
   * just finished was played.
   */
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty | null>(null);
  const [winPromptOpen, setWinPromptOpen] = useState(false);

  // The win prompt opens on the move that finishes the board, once. The ref
  // tracks whether it has already fired for this game, so undoing back out of a
  // solved state does not bring the dialog straight back up.
  const winPromptShown = useRef(false);
  useEffect(() => {
    if (!solved) {
      winPromptShown.current = false;
      return;
    }
    if (winPromptShown.current) return;
    winPromptShown.current = true;
    setWinPromptOpen(true);
  }, [solved]);

  // Asking for the tier already in play is not a change, so it starts nothing.
  const requestDifficulty = useCallback(
    (next: Difficulty) => {
      if (next === difficulty) return;
      setPendingDifficulty(next);
    },
    [difficulty]
  );

  const confirmDifficulty = useCallback(() => {
    if (pendingDifficulty === null) return;
    startNewGame(pendingDifficulty);
    setPendingDifficulty(null);
  }, [pendingDifficulty, startNewGame]);

  const placeDigit = useCallback(
    (digit: number) => {
      if (selected === null) return;
      const index = selected;

      updateGame((current) => {
        if (current.puzzle[index] !== 0) return current;

        // In notes mode the digit is pencilled in as a candidate instead of
        // being committed, and repeats toggle off.
        if (notesMode) {
          const bit = 1 << digit;
          const mark = current.notes[index] ?? 0;
          const next = mark & bit ? mark & ~bit : mark | bit;
          return { ...current, notes: setAt(current.notes, index, next) };
        }

        const from = current.values[index];
        // Placing the digit that is already there clears the cell, which is
        // what players expect from a toggle.
        const to = from === digit ? 0 : digit;
        if (to === from) return current;

        const bit = 1 << digit;

        const placed = setAt(current.values, index, to);
        // Placing the digit that crosses the threshold is what can finish the
        // board, so it is checked here rather than in an effect: one state update
        // instead of a render, a check, and a second one.
        const finished = to === 0 ? null : finishBoard(current, placed);

        return {
          ...current,
          values: finished ? finished.values : placed,
          // Committing a digit retires that digit's pencil mark everywhere it
          // can no longer go: the placed cell and every peer — same row, column,
          // or box. All three units now contain it, so a candidate pencilled in
          // any of them has been resolved. Every other mark is left alone, since
          // the rest of the reasoning is still valid. Toggling the digit back off
          // is not a commit, so it leaves the marks untouched.
          notes:
            to === 0 ? current.notes : clearBit(current.notes, index, bit),
          // The player's move, then the batch if the board got finished.
          moves: [
            ...current.moves,
            { index, from, to },
            ...(finished ? finished.moves : []),
          ],
        };
      });
    },
    [notesMode, selected, updateGame]
  );

  const eraseDigit = useCallback(() => {
    if (selected === null) return;
    const index = selected;

    updateGame((current) => {
      if (current.puzzle[index] !== 0) return current;
      if (current.values[index] === 0 && !current.notes[index]) return current;

      const hasValue = current.values[index] !== 0;

      return {
        ...current,
        values: setAt(current.values, index, 0),
        // Erasing a committed digit leaves the pencil marks alone: they still
        // describe the cell. Erasing an empty cell is how you clear its marks
        // outright.
        notes: setAt(
          current.notes,
          index,
          hasValue ? current.notes[index] ?? 0 : 0
        ),
        moves: hasValue
          ? [...current.moves, { index, from: current.values[index], to: 0 }]
          : current.moves,
      };
    });
  }, [selected, updateGame]);

  const undo = useCallback(() => {
    const lastMove = game?.moves[game.moves.length - 1];

    updateGame((current) => {
      if (current.moves.length === 0) return current;

      const move = current.moves[current.moves.length - 1];
      if (current.puzzle[move.index] !== 0) return current;

      // A batch move wrote several cells; undo empties all of them at once,
      // which is the state the player was in before the game finished it.
      const values = setAt(current.values, move.index, move.from);
      for (const index of move.fills ?? []) values[index] = 0;

      return {
        ...current,
        values,
        moves: current.moves.slice(0, -1),
      };
    });

    // Put the cursor back where the undone move happened.
    if (lastMove) setSelectedCell(lastMove.index);
  }, [game, updateGame]);

  /**
   * Placing from the number pad moves focus to the pad button, which would end
   * keyboard play. Hand focus straight back to the board instead.
   */
  const placeFromPad = useCallback(
    (digit: number) => {
      placeDigit(digit);
      boardRef.current?.focusSelected();
    },
    [placeDigit]
  );

  if (!game) {
    return (
      <div className="text-muted-foreground flex h-96 w-full max-w-xl items-center justify-center text-sm">
        Loading puzzle…
      </div>
    );
  }

  const givens = game.puzzle.filter((value) => value !== 0).length;
  // The last move carrying `fills` is the auto-complete, so the prompt can say
  // the board was finished rather than solved.
  const finishedByAssist = game.moves[game.moves.length - 1]?.fills !== undefined;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-brand-dark">
            Sudoku
          </span>
          <InstallPrompt />
          <ThemeToggle />
        </div>

        <Button
          type="button"
          className="font-semibold"
          onClick={() => startNewGame(difficulty)}
        >
          New game
        </Button>
      </header>

      {/* Difficulty selector. Picking a tier asks first: the game in play is
          thrown away, so the button opens a prompt rather than deciding. */}
      <div className="flex flex-wrap items-center gap-1 text-sm">
        {DIFFICULTIES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={difficulty === option}
            onClick={() => requestDifficulty(option)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors",
              difficulty === option
                ? "bg-card text-brand-dark shadow-sm"
                : "text-board-given hover:text-brand-dark"
            )}
          >
            {DIFFICULTY_LABELS[option]}
          </button>
        ))}
      </div>

      {/* `--board` is the board's edge length: capped by the viewport height, and by
          the row width divided by 1.7 so the board plus a 70%-sized square pad
          both fit. Sizing the pad from the same expression keeps the two in
          proportion without either depending on the other's measured size. */}
      <div className="flex flex-col gap-4 [--board:min(calc(100dvh_-_15rem),calc((100%_-_1.5rem)/1.7))] lg:flex-row lg:items-stretch lg:gap-6">
        <div className="w-full lg:max-w-[var(--board)] lg:flex-1">
          <Board
            ref={boardRef}
            puzzle={game.puzzle}
            values={game.values}
            notes={game.notes}
            errors={errors}
            duplicateDigits={duplicateDigits}
            selected={selected}
            onSelect={setSelectedCell}
            onPlace={placeDigit}
            onErase={eraseDigit}
          />
        </div>

        {/* `lg:w-auto` lets the column take its width from the square pad below it
            instead of the `w-full` used by the stacked layout. */}
        <div className="flex w-full shrink-0 flex-col gap-4 lg:w-[calc(var(--board)*0.7)]">
          <Toolbar
            notesMode={notesMode}
            canUndo={game.moves.length > 0}
            onUndo={undo}
            onErase={eraseDigit}
            onToggleNotes={() => setNotesMode((value) => !value)}
          />

          {/* The column is 70% of the board's edge, so a square block inside it makes
              the 3x3 keys square. No percentage heights, which would be
              circular: the height would depend on a width that depends on it. */}
          <div className="lg:aspect-square">
            <NumberPad
              values={game.values}
              wrongCells={errors}
              onPlace={placeFromPad}
              disabled={solved}
            />
          </div>
        </div>
      </div>

      {/* Winning opens this rather than a banner on the board: the only thing
          left to do is start another game, and that is a decision worth asking
          about. Cancelling leaves the finished board exactly as it is. */}
      <AlertDialog open={winPromptOpen} onOpenChange={setWinPromptOpen}>
        <AlertDialogPortal>
          <AlertDialogBackdrop />
          <AlertDialogPopup>
            <div className="flex flex-col gap-1.5">
              <AlertDialogTitle>Solved.</AlertDialogTitle>
              <AlertDialogDescription>
                {DIFFICULTY_LABELS[game.difficulty]} with {givens} clues,{" "}
                {finishedByAssist
                  ? "all but finished, so the last cells were filled in for you."
                  : `solved in ${game.moves.length} moves.`}{" "}
                Start another one?
              </AlertDialogDescription>
            </div>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel className={PROMPT_BUTTON} render={
                <Button variant="outline" size="lg" />
              }>
                Keep board
              </AlertDialogCancel>
              <AlertDialogAction
                className={PROMPT_BUTTON}
                render={<Button />}
                onClick={() => startNewGame(difficulty)}
              >
                New game
              </AlertDialogAction>
            </div>
          </AlertDialogPopup>
        </AlertDialogPortal>
      </AlertDialog>

      {/* Every tier change replaces the game, so it asks before doing it. */}
      <AlertDialog
        open={pendingDifficulty !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDifficulty(null);
        }}
      >
        <AlertDialogPortal>
          <AlertDialogBackdrop />
          <AlertDialogPopup>
            <div className="flex flex-col gap-1.5">
              <AlertDialogTitle>
                Switch to {pendingDifficulty ? DIFFICULTY_LABELS[pendingDifficulty] : ""}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The game in play is thrown away and a fresh
                {pendingDifficulty
                  ? ` ${DIFFICULTY_LABELS[pendingDifficulty].toLowerCase()}`
                  : ""}{" "}
                board takes its place.
              </AlertDialogDescription>
            </div>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel className={PROMPT_BUTTON} render={
                <Button variant="outline" size="lg" />
              }>
                Keep playing
              </AlertDialogCancel>
              <AlertDialogAction className={PROMPT_BUTTON} render={<Button />} onClick={confirmDifficulty}>
                Switch tier
              </AlertDialogAction>
            </div>
          </AlertDialogPopup>
        </AlertDialogPortal>
      </AlertDialog>
    </div>
  );
}