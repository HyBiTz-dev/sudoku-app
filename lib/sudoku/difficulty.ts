/**
 * Technique analysis.
 *
 * Replays the puzzle using only the techniques a human would apply and reports
 * the hardest one that was needed. This is genuinely useful information about a
 * puzzle — "this one only needs singles" or "this one demands box-line
 * reasoning" — but it is not a difficulty tier: digging holes at random almost
 * always leaves a puzzle that singles can finish, so tiering by technique would
 * call nearly everything easy.
 *
 * If the run gets stuck, the puzzle demands guessing. A backtracker finds the
 * answer, but a person cannot follow it.
 */

import {
  BOX_UNITS,
  CELL_COUNT,
  UNITS,
  boxOf,
  colOf,
  computeCandidates,
  isSolved,
  popcount,
  rowOf,
  type Grid,
} from "./engine";

export type Technique =
  | "nakedSingle"
  | "hiddenSingle"
  | "nakedPair"
  | "lockedCandidates";

export const TECHNIQUE_LABELS: Record<Technique, string> = {
  nakedSingle: "Naked singles",
  hiddenSingle: "Hidden singles",
  nakedPair: "Naked pairs",
  lockedCandidates: "Box-line reasoning",
};

export interface Rating {
  /** The hardest technique the puzzle required, or `null` if it needed guessing. */
  hardest: Technique | null;
  /** True when no human technique sequence can solve it. */
  requiresGuessing: boolean;
}

type Step =
  | { kind: "assign"; index: number; digit: number }
  | { kind: "eliminate"; index: number; bit: number };

function applyStep(values: Grid, candidates: number[], step: Step) {
  if (step.kind === "assign") {
    values[step.index] = step.digit;
    candidates[step.index] = 0;
    return;
  }
  candidates[step.index] &= ~step.bit;
}

/** An empty cell with exactly one remaining candidate. */
function findNakedSingle(values: Grid, candidates: number[]): Step | null {
  for (let index = 0; index < CELL_COUNT; index++) {
    if (values[index]) continue;
    if (popcount(candidates[index]) === 1) {
      return { kind: "assign", index, digit: Math.log2(candidates[index]) };
    }
  }
  return null;
}

/** A digit with exactly one home left in a row, column, or box. */
function findHiddenSingle(values: Grid, candidates: number[]): Step | null {
  for (const unit of UNITS) {
    const placed = unit.reduce((mask, cell) => mask | (values[cell] ? 1 << values[cell] : 0), 0);

    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << digit;
      if (placed & bit) continue;

      let target = -1;
      let count = 0;

      for (const cell of unit) {
        if (values[cell] || !(candidates[cell] & bit)) continue;
        target = cell;
        count++;
      }

      if (count === 1) return { kind: "assign", index: target, digit };
    }
  }
  return null;
}

/**
 * Two cells in a unit that share the same two candidates: both digits must be
 * in that pair, so they can be removed from the rest of the unit.
 */
function findNakedPair(values: Grid, candidates: number[]): Step | null {
  for (const unit of UNITS) {
    const open = unit.filter((cell) => !values[cell]);

    for (let a = 0; a < open.length; a++) {
      for (let b = a + 1; b < open.length; b++) {
        const mask = candidates[open[a]];
        if (popcount(mask) !== 2 || candidates[open[b]] !== mask) continue;

        for (const cell of open) {
          if (cell === open[a] || cell === open[b]) continue;
          const bit = candidates[cell] & mask;
          if (bit) return { kind: "eliminate", index: cell, bit };
        }
      }
    }
  }
  return null;
}

/**
 * Pointing and claiming: when a digit inside a box is only ever a candidate in
 * one row (or one column), that digit cannot appear elsewhere in the row.
 */
function findLockedCandidate(values: Grid, candidates: number[]): Step | null {
  for (let box = 0; box < 9; box++) {
    const boxCells = BOX_UNITS[box];

    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << digit;

      const rowsHere = new Set<number>();
      const colsHere = new Set<number>();
      for (const cell of boxCells) {
        if (candidates[cell] & bit) {
          rowsHere.add(rowOf(cell));
          colsHere.add(colOf(cell));
        }
      }
      if (rowsHere.size === 0) continue;

      if (rowsHere.size === 1) {
        const row = [...rowsHere][0];
        for (let col = 0; col < 9; col++) {
          const cell = row * 9 + col;
          if (boxOf(cell) === box || values[cell]) continue;
          if (candidates[cell] & bit) return { kind: "eliminate", index: cell, bit };
        }
      }

      if (colsHere.size === 1) {
        const col = [...colsHere][0];
        for (let row = 0; row < 9; row++) {
          const cell = row * 9 + col;
          if (boxOf(cell) === box || values[cell]) continue;
          if (candidates[cell] & bit) return { kind: "eliminate", index: cell, bit };
        }
      }
    }
  }
  return null;
}

const SOLVERS: [Technique, (values: Grid, candidates: number[]) => Step | null][] = [
  ["nakedSingle", findNakedSingle],
  ["hiddenSingle", findHiddenSingle],
  ["nakedPair", findNakedPair],
  ["lockedCandidates", findLockedCandidate],
];

/**
 * Walk the puzzle with human techniques only and report what was needed.
 *
 * Assume the puzzle has a unique solution; call `ratePuzzle` on generated
 * puzzles, not on arbitrary input.
 */
export function ratePuzzle(puzzle: Grid): Rating {
  const values = puzzle.slice();
  let candidates = computeCandidates(values);
  let hardest: Technique | null = null;
  const orderOf = (technique: Technique) => SOLVERS.findIndex(([name]) => name === technique);

  // Every step fills a cell or strips a candidate, so the search space shrinks
  // every iteration. The cap is a safety net, not a real limit.
  for (let step = 0; step < 10_000; step++) {
    if (isSolved(values)) break;

    let applied = false;

    for (const [technique, findStep] of SOLVERS) {
      const next = findStep(values, candidates);
      if (!next) continue;

      applyStep(values, candidates, next);
      if (next.kind === "assign") candidates = computeCandidates(values);
      if (!hardest || orderOf(hardest) < orderOf(technique)) hardest = technique;
      applied = true;
      break;
    }

    if (!applied) {
      // No technique applies but the grid is unfinished: guessing is required.
      return { hardest: null, requiresGuessing: true };
    }
  }

  return { hardest, requiresGuessing: false };
}