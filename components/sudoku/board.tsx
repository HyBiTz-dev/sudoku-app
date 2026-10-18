"use client";

import { useImperativeHandle, useRef } from "react";
import { cn } from "cn";
import {
  colOf,
  isSolved,
  rowOf,
  PEERS,
  type Grid,
} from "@/lib/sudoku/engine";

export interface BoardHandle {
  /** Move keyboard focus back to the selected cell. */
  focusSelected: () => void;
}

interface BoardProps {
  puzzle: Grid;
  values: Grid;
  /** Pencil marks, one 9-bit mask per cell. `0` means no notes. */
  notes: number[];
  /**
   * Cells whose value contradicts the unique solution. Only their digit turns
   * red — no background, so the cell itself stays readable.
   */
  errors: Set<number>;
  /**
   * Cells showing a digit that is wrong somewhere else on the board. These get
   * a red background, which is where the duplicate actually is.
   */
  duplicateDigits: Set<number>;
  selected: number | null;
  onSelect: (index: number) => void;
  onPlace: (digit: number) => void;
  onErase: () => void;
}

export function Board({
  puzzle,
  values,
  notes,
  errors,
  duplicateDigits,
  selected,
  onSelect,
  onPlace,
  onErase,
  ref,
}: BoardProps & { ref?: React.Ref<BoardHandle> }) {
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const solved = isSolved(values);

  useImperativeHandle(
    ref,
    () => ({
      focusSelected: () => {
        if (selected !== null) cellRefs.current[selected]?.focus();
      },
    }),
    [selected]
  );

  function focusCell(index: number) {
    onSelect(index);
    cellRefs.current[index]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (solved || selected === null) return;

    if (event.key >= "1" && event.key <= "9") {
      event.preventDefault();
      onPlace(Number(event.key));
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete" || event.key === "0") {
      event.preventDefault();
      onErase();
      return;
    }

    const row = rowOf(selected);
    const col = colOf(selected);

    // Horizontal moves wrap inside the row, vertical moves clamp to the grid.
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = row * 9 + ((col + 8) % 9);
        break;
      case "ArrowRight":
        next = row * 9 + ((col + 1) % 9);
        break;
      case "ArrowUp":
        next = Math.max(0, selected - 9);
        break;
      case "ArrowDown":
        next = Math.min(values.length - 1, selected + 9);
        break;
      case "Home":
        next = event.ctrlKey ? 0 : row * 9;
        break;
      case "End":
        next = event.ctrlKey ? values.length - 1 : row * 9 + 8;
        break;
      default:
        return;
    }

    event.preventDefault();
    focusCell(next);
  }

  return (
    <div
      role="grid"
      aria-label="Sudoku board"
      className="w-full overflow-hidden rounded-sm border-2 border-board-box select-none"
      onKeyDown={handleKeyDown}
    >
      {Array.from({ length: 9 }, (_, row) => (
        <div key={row} role="row" className="grid grid-cols-9">
          {Array.from({ length: 9 }, (_, col) => {
            const index = row * 9 + col;
            const value = values[index];
            const isGiven = puzzle[index] !== 0;
            const isSelected = index === selected;

            // Peers share a row, column, or box with the selected cell.
            const isPeer =
              selected !== null && !isSelected && PEERS[index].includes(selected);
            const matchesSelection =
              selected !== null && value !== 0 && value === values[selected];
            const isError = errors.has(index);
            // A wrong digit paints its twins red, but not itself: that cell
            // keeps a clean background with only the digit coloured.
            const showsWrongDigit =
              duplicateDigits.has(index) && !isError && value !== 0;

            return (
              <button
                key={index}
                ref={(node) => {
                  cellRefs.current[index] = node;
                }}
                type="button"
                role="gridcell"
                aria-selected={isSelected}
                aria-label={
                  value
                    ? `Row ${row + 1} column ${col + 1}, ${value}`
                    : `Row ${row + 1} column ${col + 1}, empty`
                }
                tabIndex={isSelected ? 0 : -1}
                onClick={() => focusCell(index)}
                // `container-type: inline-size` lets the pencil marks size their
                // digits against the cell width (see `cqw` below), so they fill
                // the box at every board size.
                style={{
                  // Lets the pencil marks size their digits against the cell
                  // width (see `cqw` below) so they fill the box at any size.
                  containerType: "inline-size",
                  // Applied inline on purpose. Tailwind emits its background
                  // utilities in its own stylesheet order, so a `bg-*` class
                  // here would lose to `bg-board-match` / `bg-board-selected`
                  // for any twin in the selected cell's row or column — the
                  // exact cells this highlight is meant to catch.
                  backgroundColor: showsWrongDigit ? "var(--board-conflict)" : undefined,
                }}
                className={cn(
                  // Only the right and bottom edges, so each interior line is
                  // drawn once. A full `border` would double every shared edge
                  // and make the whole grid look twice as heavy.
                  "relative flex aspect-square items-center justify-center border-r border-b border-board-line",
                  col === 8 && "border-r-0",
                  row === 8 && "border-b-0",
                  col % 3 === 2 && col !== 8 && "border-r-2 border-r-board-box",
                  row % 3 === 2 && row !== 8 && "border-b-2 border-b-board-box",
                  "bg-board-cell transition-colors",
                  isPeer && "bg-board-peer",
                  matchesSelection && "bg-board-match",
                  isSelected && "bg-board-selected",
                  // No ring on either input path. The selected cell is marked by
                  // its background alone, which reads the same whether you
                  // arrive by click or by keyboard.
                  "focus:outline-none"
                )}
              >
                {value ? (
                  <span
                    className={cn(
                      "text-2xl leading-none sm:text-3xl lg:text-4xl",
                      isGiven ? "font-medium text-board-given" : "font-semibold text-board-entered",
                      isError && "text-board-wrong"
                    )}
                  >
                    {value}
                  </span>
                ) : (
                  <PencilMarks mask={notes[index] ?? 0} />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * The 3x3 grid of candidate digits inside an empty cell.
 *
 * It stretches to fill the cell edge to edge — `w-full h-full` with
 * `place-content-center` — so the marks occupy the whole box rather than
 * huddling in the middle, and the digit size scales with the cell via
 * `cqw` so the layout holds at any board size instead of only at the
 * breakpoints Tailwind happens to ship.
 */
function PencilMarks({ mask }: { mask: number }) {
  if (!mask) return null;

  return (
    <span className="grid h-full w-full grid-cols-3 grid-rows-3 place-items-center text-[clamp(0.6rem,24cqw,1.5rem)] leading-none font-normal text-board-given/80 tabular-nums">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
        <span key={digit} className="text-center">
          {mask & (1 << digit) ? digit : ""}
        </span>
      ))}
    </span>
  );
}