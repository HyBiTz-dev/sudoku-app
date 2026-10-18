"use client";

import { cn } from "cn";
import { Check } from "lucide-react";
import type { Grid } from "@/lib/sudoku/engine";

interface NumberPadProps {
  values: Grid;
  /**
   * Cells whose digit contradicts the unique solution. A digit is only finished
   * when all nine of its copies are right, so a spent digit that includes a wrong
   * placement must not claim to be complete.
   */
  wrongCells?: ReadonlySet<number>;
  onPlace: (digit: number) => void;
  disabled?: boolean;
  className?: string;
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** How many copies of each digit are still unplaced. */
function remainingOf(values: Grid): number[] {
  const counts = new Array<number>(10).fill(9);
  for (const value of values) {
    if (value) counts[value] -= 1;
  }
  return counts;
}

/** How many wrongly placed copies of each digit are on the board. */
function wrongOf(values: Grid, wrongCells: ReadonlySet<number>): number[] {
  const counts = new Array<number>(10).fill(0);
  for (const index of wrongCells) {
    const value = values[index];
    if (value) counts[value] += 1;
  }
  return counts;
}

export function NumberPad({
  values,
  wrongCells,
  onPlace,
  disabled,
  className,
}: NumberPadProps) {
  const remaining = remainingOf(values);
  const wrong = wrongOf(values, wrongCells ?? new Set());

  return (
    <div
      className={cn(
        // One row of keys on small screens; a square 3x3 block that fills the
        // square wrapper beside the board on large ones.
        "grid grid-cols-9 gap-2 sm:gap-3 lg:h-full lg:grid-cols-3 lg:grid-rows-3",
        className
      )}
    >
      {DIGITS.map((digit) => {
        // Two different states, not one. `spent` means the key can no longer be
        // placed, which is a count. `complete` means the digit is genuinely
        // finished, which takes correctness into account: nine copies placed with
        // a wrong one among them is spent, not complete.
        const spent = remaining[digit] <= 0;
        const complete = spent && wrong[digit] === 0;

        return (
          <button
            key={digit}
            type="button"
            disabled={disabled || spent}
            onClick={() => onPlace(digit)}
            aria-label={`${digit}, ${complete ? "complete" : `${remaining[digit]} remaining`}`}
            className={cn(
              "flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-lg font-semibold tabular-nums transition-colors",
              "text-xl lg:h-auto lg:text-4xl",
              // Every key is a filled button at every width. The stacked layout
              // used to show bare digits, which read as text rather than targets.
              // A used-up key is the exception in that layout: it is blank there,
              // fill and all, so it stops drawing over the board at all. The two
              // branches never both apply `bg-*`, so the fill never depends on
              // which background utility Tailwind happens to emit last.
              "lg:aspect-auto",
              spent
                ? `lg:bg-board-surface lg:hover:bg-board-peer text-board-given/30 ${
                    complete ? "lg:text-board-entered/70" : ""
                  }`
                : "bg-board-surface hover:bg-board-peer text-brand lg:text-board-entered",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            )}
          >
            {/* A correct digit placed in all nine cells is finished, so the key
                swaps to a tick beside the board. A digit spent on a wrong
                placement keeps its faint digit beside the board: it is used up,
                but not finished. Both live in the DOM and are separated by the
                `lg` breakpoint. */}
            {complete && (
              <span className="hidden lg:flex lg:size-full lg:items-center lg:justify-center">
                {/* Sized as a share of the key, which is itself a share of the
                    board, so the tick scales with the layout at any width. */}
                <Check className="size-[55%]" strokeWidth={2.5} />
              </span>
            )}
            {/* The digit and the count are siblings, not nested: they are the two
                flex children of the `flex-col` key, so the count sits on its own
                row under the digit. Wrapping them in one span made it inline and
                pulled the count up onto the digit's baseline. */}
            <span className={cn(spent && "hidden", complete && "lg:hidden")}>
              {digit}
            </span>
            <span
              className={cn(
                "text-[0.625rem] leading-none font-normal text-board-given/60 lg:text-xs",
                // A spent digit empties the key outright in the stacked layout —
                // there is no room for a tick, and a leftover digit at 30% just
                // adds noise to a row of nine.
                spent && "hidden",
                complete && "lg:hidden"
              )}
            >
              {remaining[digit]}
            </span>
          </button>
        );
      })}
    </div>
  );
}