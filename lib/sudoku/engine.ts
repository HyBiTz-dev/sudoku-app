/**
 * Sudoku engine: grid helpers, a backtracking solver, and hole-digging.
 *
 * Pure TypeScript with no React and no browser APIs, so it runs identically
 * on the server and the client. Digits are 1-9; `0` marks an empty cell.
 *
 * The solver works on 9-bit masks (bit `n` = digit `n`) with an MRV heuristic:
 * at every step it fills the empty cell with the fewest candidates. That runs
 * fast enough to validate uniqueness after each hole, which is what makes
 * generation instant.
 */

export type Grid = number[];

export const CELL_COUNT = 81;
/** Bits 1-9 set; bit `n` represents digit `n`. */
export const FULL_MASK = 0b1111111110;

const POPCOUNT = new Uint8Array(1024);
for (let mask = 0; mask < 1024; mask++) {
  POPCOUNT[mask] = (mask & 1) + POPCOUNT[mask >> 1];
}

export function popcount(mask: number): number {
  return POPCOUNT[mask];
}

export function rowOf(index: number): number {
  return (index / 9) | 0;
}

export function colOf(index: number): number {
  return index % 9;
}

export function boxOf(index: number): number {
  return (((rowOf(index) / 3) | 0) * 3) + ((colOf(index) / 3) | 0);
}

/** The 27 units a digit must appear exactly once in: 9 rows, 9 cols, 9 boxes. */
export const UNITS: number[][] = (() => {
  const units: number[][] = [];

  for (let row = 0; row < 9; row++) {
    units.push(Array.from({ length: 9 }, (_, col) => row * 9 + col));
  }

  for (let col = 0; col < 9; col++) {
    units.push(Array.from({ length: 9 }, (_, row) => row * 9 + col));
  }

  for (let box = 0; box < 9; box++) {
    const startRow = ((box / 3) | 0) * 3;
    const startCol = (box % 3) * 3;
    units.push(
      Array.from(
        { length: 9 },
        (_, k) => (startRow + ((k / 3) | 0)) * 9 + startCol + (k % 3)
      )
    );
  }

  return units;
})();

export const ROW_UNITS = UNITS.slice(0, 9);
export const COL_UNITS = UNITS.slice(9, 18);
export const BOX_UNITS = UNITS.slice(18);

/** The 20 cells that share a unit with each cell. */
export const PEERS: number[][] = Array.from({ length: CELL_COUNT }, (_, index) => {
  const ownUnits = [
    ROW_UNITS[rowOf(index)],
    COL_UNITS[colOf(index)],
    BOX_UNITS[boxOf(index)],
  ];

  const peers = new Set<number>();
  for (const unit of ownUnits) {
    for (const cell of unit) {
      if (cell !== index) peers.add(cell);
    }
  }

  return [...peers].sort((a, b) => a - b);
});

function unitMasks(values: Grid) {
  const rows = new Array<number>(9).fill(0);
  const cols = new Array<number>(9).fill(0);
  const boxes = new Array<number>(9).fill(0);

  for (let index = 0; index < CELL_COUNT; index++) {
    const value = values[index];
    if (!value) continue;
    const bit = 1 << value;
    rows[rowOf(index)] |= bit;
    cols[colOf(index)] |= bit;
    boxes[boxOf(index)] |= bit;
  }

  return { rows, cols, boxes };
}

/** Candidate mask per cell: `0` for filled cells, otherwise the possible digits. */
export function computeCandidates(values: Grid): number[] {
  const { rows, cols, boxes } = unitMasks(values);
  const candidates = new Array<number>(CELL_COUNT).fill(0);

  for (let index = 0; index < CELL_COUNT; index++) {
    if (values[index]) continue;
    const blocked = rows[rowOf(index)] | cols[colOf(index)] | boxes[boxOf(index)];
    candidates[index] = FULL_MASK & ~blocked;
  }

  return candidates;
}

/** Cells that break the row/column/box rules, used to flag conflicts in the UI. */
export function findConflicts(values: Grid): Set<number> {
  const seen = { rows: new Array<number>(9).fill(0), cols: new Array<number>(9).fill(0), boxes: new Array<number>(9).fill(0) };
  const dup = { rows: new Array<number>(9).fill(0), cols: new Array<number>(9).fill(0), boxes: new Array<number>(9).fill(0) };

  for (let index = 0; index < CELL_COUNT; index++) {
    const value = values[index];
    if (!value) continue;
    const bit = 1 << value;
    const coords = [
      ["rows", rowOf(index)],
      ["cols", colOf(index)],
      ["boxes", boxOf(index)],
    ] as const;

    for (const [group, coord] of coords) {
      if (seen[group][coord] & bit) dup[group][coord] |= bit;
      seen[group][coord] |= bit;
    }
  }

  if (!dup.rows.some(Boolean) && !dup.cols.some(Boolean) && !dup.boxes.some(Boolean)) {
    return new Set();
  }

  const conflicts = new Set<number>();
  for (let index = 0; index < CELL_COUNT; index++) {
    const value = values[index];
    if (!value) continue;
    const bit = 1 << value;
    if (dup.rows[rowOf(index)] & bit || dup.cols[colOf(index)] & bit || dup.boxes[boxOf(index)] & bit) {
      conflicts.add(index);
    }
  }

  return conflicts;
}

/** True when the grid is complete and breaks none of the rules. */
export function isSolved(values: Grid): boolean {
  if (values.some((value) => value === 0)) return false;
  return findConflicts(values).size === 0;
}

function bitsOf(mask: number): number[] {
  const bits: number[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    if (mask & (1 << digit)) bits.push(1 << digit);
  }
  return bits;
}

function digitOf(bit: number): number {
  return 31 - Math.clz32(bit);
}

export interface SolveResult {
  /** The first solution found, or `null` when the grid is unsolvable. */
  solved: Grid | null;
  /** How many solutions were found, capped at the requested limit. */
  count: number;
}

/**
 * Solve `grid`, stopping once `limit` solutions have been found.
 *
 * Pass a `random` function to try digits in random order, which randomises the
 * solution used for generation.
 */
export function solveGrid(
  grid: Grid,
  options: { limit?: number; random?: () => number } = {}
): SolveResult {
  const limit = options.limit ?? 1;
  const random = options.random;

  // A grid with a duplicate digit is malformed rather than unsolvable, so it
  // has no solutions at all.
  if (findConflicts(grid).size > 0) return { solved: null, count: 0 };

  const values = grid.slice();
  const { rows, cols, boxes } = unitMasks(values);
  const result: SolveResult = { solved: null, count: 0 };

  function search(): void {
    // Pick the empty cell with the fewest candidates (MRV). The scan restarts
    // from 0 every step because the MRV cell is usually not the leftmost
    // empty cell, so a forward-only cursor would skip past holes.
    let target = -1;
    let targetMask = 0;
    let fewest = 10;

    for (let index = 0; index < CELL_COUNT; index++) {
      if (values[index]) continue;
      const blocked = rows[rowOf(index)] | cols[colOf(index)] | boxes[boxOf(index)];
      const mask = FULL_MASK & ~blocked;
      if (mask === 0) return;
      const count = POPCOUNT[mask];
      if (count < fewest) {
        fewest = count;
        target = index;
        targetMask = mask;
        if (count === 1) break;
      }
    }

    if (target === -1) {
      result.count++;
      result.solved ??= values.slice();
      return;
    }

    const bits = bitsOf(targetMask);
    if (random) shuffleInPlace(bits, random);

    const row = rowOf(target);
    const col = colOf(target);
    const box = boxOf(target);

    for (const bit of bits) {
      values[target] = digitOf(bit);
      rows[row] |= bit;
      cols[col] |= bit;
      boxes[box] |= bit;

      search();

      values[target] = 0;
      rows[row] ^= bit;
      cols[col] ^= bit;
      boxes[box] ^= bit;

      if (result.count >= limit) return;
    }
  }

  search();
  return result;
}

export function countSolutions(grid: Grid, limit = 2): number {
  return solveGrid(grid, { limit }).count;
}

/** A well-formed puzzle has exactly one solution. */
export function hasUniqueSolution(grid: Grid): boolean {
  return countSolutions(grid, 2) === 1;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** A random complete, valid grid. */
export function createSolvedGrid(random: () => number = Math.random): Grid {
  return solveGrid(new Array<number>(CELL_COUNT).fill(0), { random }).solved ?? new Array<number>(CELL_COUNT).fill(0);
}

/**
 * Remove cells from `solution` until `targetGivens` remain, keeping 180°
 * rotational symmetry and rejecting any removal that would leave the puzzle
 * with more than one solution.
 */
export function digHoles(solution: Grid, targetGivens: number, random: () => number): Grid {
  const puzzle = solution.slice();
  // Cell `i` and cell `80 - i` are the symmetric pair, so only scan the
  // first 41 indices to touch each pair exactly once.
  const order = shuffleInPlace(
    Array.from({ length: 41 }, (_, i) => i),
    random
  );

  let givens = CELL_COUNT;

  for (const index of order) {
    if (givens <= targetGivens) break;

    const mirror = CELL_COUNT - 1 - index;
    const kept = [puzzle[index], puzzle[mirror]];
    puzzle[index] = 0;
    puzzle[mirror] = 0;
    givens -= 2;

    if (!hasUniqueSolution(puzzle)) {
      puzzle[index] = kept[0];
      puzzle[mirror] = kept[1];
      givens += 2;
    }
  }

  return puzzle;
}

export function countGivens(grid: Grid): number {
  return grid.reduce((total, value) => total + (value ? 1 : 0), 0);
}