/**
 * Puzzle generation.
 *
 * Difficulty is defined by how many clues remain: that is what a player
 * actually feels. Uniqueness is enforced for every hole removed, so a puzzle
 * is always solvable and has exactly one answer.
 *
 * The technique analysis from `difficulty.ts` is carried along as extra detail
 * rather than as the tier itself. Random digging almost always leaves a puzzle
 * that singles can finish, so using the technique rating as the tier would
 * label nearly every puzzle "easy".
 */

import {
  countGivens,
  createSolvedGrid,
  digHoles,
  hasUniqueSolution,
  mulberry32,
  type Grid,
} from "./engine";
import { ratePuzzle, type Rating } from "./difficulty";

export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  expert: "Expert",
};

interface Preset {
  /** How many cells stay filled. Fewer clues means a longer solve. */
  givens: number;
  /**
   * How many puzzles to try. Digging can stall before reaching the clue
   * target when a removal would leave two solutions, and a fresh solution
   * grid usually digs further.
   */
  attempts: number;
}

export const PRESETS: Record<Difficulty, Preset> = {
  easy: { givens: 45, attempts: 2 },
  medium: { givens: 38, attempts: 3 },
  hard: { givens: 32, attempts: 4 },
  expert: { givens: 26, attempts: 6 },
};

export interface Puzzle {
  puzzle: Grid;
  solution: Grid;
  difficulty: Difficulty;
  givens: number;
  /** What the hardest human technique required turned out to be. */
  analysis: Rating;
  seed: number;
}

export function generatePuzzle(options: { difficulty: Difficulty; seed?: number }): Puzzle {
  const { difficulty } = options;
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = mulberry32(seed);
  const preset = PRESETS[difficulty];

  let best: Puzzle | null = null;

  for (let attempt = 0; attempt < preset.attempts; attempt++) {
    const solution = createSolvedGrid(random);
    const puzzle = digHoles(solution, preset.givens, random);

    // `digHoles` rejects any removal that breaks uniqueness, so this only ever
    // fails if the grid is mutated incorrectly.
    if (!hasUniqueSolution(puzzle)) continue;

    const candidate: Puzzle = {
      puzzle,
      solution,
      difficulty,
      givens: countGivens(puzzle),
      analysis: ratePuzzle(puzzle),
      seed,
    };

    // Keep the puzzle that got closest to the requested clue count.
    if (!best || candidate.givens < best.givens) best = candidate;
  }

  // Digging always yields a valid puzzle, so this is unreachable in practice.
  return best ?? fallbackPuzzle(difficulty, seed);
}

function fallbackPuzzle(difficulty: Difficulty, seed: number): Puzzle {
  const solution = createSolvedGrid(mulberry32(seed));
  return {
    puzzle: solution.slice(),
    solution,
    difficulty,
    givens: countGivens(solution),
    analysis: ratePuzzle(solution),
    seed,
  };
}