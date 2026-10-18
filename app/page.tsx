import { SudokuGame } from "@/components/sudoku/sudoku-game";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <SudokuGame />
    </main>
  );
}