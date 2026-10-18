/**
 * Sanity checks for the sudoku engine. Run with: bun run lib/sudoku/engine.test.ts
 */
import {
  countGivens,
  findConflicts,
  hasUniqueSolution,
  isSolved,
  mulberry32,
  solveGrid,
} from "./engine";
import { generatePuzzle, DIFFICULTIES } from "./generate";
import { ratePuzzle } from "./difficulty";

let failures = 0;
function check(label: string, condition: boolean) {
  if (!condition) {
    failures++;
    console.error(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

// 1. Generated puzzles are valid, unique, and solved by the solver.
const puzzle = generatePuzzle({ difficulty: "medium", seed: 12345 });
check("generated puzzle has one solution", hasUniqueSolution(puzzle.puzzle));
check(
  "generated puzzle has no duplicate digits",
  findConflicts(puzzle.puzzle).size === 0
);
check("givens are non-zero", countGivens(puzzle.puzzle) > 0);
check(
  "solver reproduces the generator's solution",
  solveGrid(puzzle.puzzle).solved?.join("") === puzzle.solution.join("")
);
check("generator's own solution is complete", isSolved(puzzle.solution));
check("requested difficulty is reported", puzzle.difficulty === "medium");

// 2. 180-degree symmetry: cell i is empty exactly when cell 80-i is empty.
//    The digits themselves need not match, only the pattern of holes.
const symmetrical = puzzle.puzzle.every(
  (value, index) => (value === 0) === (puzzle.puzzle[80 - index] === 0)
);
check("puzzle keeps rotational symmetry", symmetrical);

// 3. Rating agrees with itself: a near-empty board cannot be solved by
//    single-cell logic, so the technique run must get stuck.
const nearEmpty = new Array(81).fill(0);
nearEmpty[0] = 1;
check("near-empty grid needs guessing", ratePuzzle(nearEmpty).requiresGuessing);

// 4. A fully solved grid needs no guessing and no techniques.
const solution = puzzle.solution;
check("solved grid needs no guessing", !ratePuzzle(solution).requiresGuessing);
check("solved grid needs no technique", ratePuzzle(solution).hardest === null);

// 5. An unsolvable grid reports no solutions.
const broken = puzzle.puzzle.slice();
broken[0] = broken[0] === 1 ? 2 : 1;
check("invalid grid has no solution", solveGrid(broken).count === 0);

// 6. Every difficulty tier generates a valid puzzle and is reasonably quick.
for (const difficulty of DIFFICULTIES) {
  const started = performance.now();
  const generated = generatePuzzle({ difficulty, seed: 999 });
  const elapsed = performance.now() - started;

  check(`${difficulty}: has a unique solution`, hasUniqueSolution(generated.puzzle));
  check(`${difficulty}: has the requested tier`, generated.difficulty === difficulty);
  check(
    `${difficulty}: givens are counted correctly`,
    generated.givens === countGivens(generated.puzzle)
  );
  check(
    `${difficulty}: generation is fast`,
    elapsed < 500
  );
  console.log(
    `      ${difficulty.padEnd(6)} -> ${String(generated.givens).padStart(2)} givens, hardest technique: ${
      generated.analysis.requiresGuessing
        ? "guessing required"
        : (generated.analysis.hardest ?? "none")
    } (${elapsed.toFixed(1)}ms)`
  );
}

// 7. Difficulty should trend: harder presets should not be rated easier.

const easyCount = generatePuzzle({ difficulty: "easy", seed: 4 }).givens;
const hardCount = generatePuzzle({ difficulty: "hard", seed: 4 }).givens;
check("harder preset has fewer givens", hardCount < easyCount);
check(
  "same seed yields the same puzzle",
  generatePuzzle({ difficulty: "medium", seed: 7 }).puzzle.join("") ===
    generatePuzzle({ difficulty: "medium", seed: 7 }).puzzle.join("")
);
check(
  "different seeds yield different puzzles",
  generatePuzzle({ difficulty: "medium", seed: 1 }).puzzle.join("") !==
    generatePuzzle({ difficulty: "medium", seed: 2 }).puzzle.join("")
);
check(
  "seeded random is reproducible",
  mulberry32(3)() === mulberry32(3)()
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);