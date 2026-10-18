"use client";

import { cn } from "cn";
import { Eraser, Pencil, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ToolbarProps {
  notesMode: boolean;
  canUndo: boolean;
  onUndo: () => void;
  onErase: () => void;
  onToggleNotes: () => void;
}

const ICON_BUTTON =
  "relative size-10 rounded-full bg-board-surface text-board-given transition-colors hover:bg-board-peer disabled:opacity-40";

export function Toolbar({
  notesMode,
  canUndo,
  onUndo,
  onErase,
  onToggleNotes,
}: ToolbarProps) {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-4">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(ICON_BUTTON, "size-11 sm:size-12")}
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo"
      >
        <Undo2 className="size-5" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(ICON_BUTTON, "size-11 sm:size-12")}
        onClick={onErase}
        aria-label="Erase"
        title="Erase"
      >
        <Eraser className="size-5" />
      </Button>

      {/* Notes carries an ON/OFF badge, so the mode is readable without the
          colour alone. While it is on the button fills with the solid brand blue
          — the pale `--board-selected` wash is too close to the disabled look —
          and keeps the same rounded shape as its neighbours. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleNotes}
        className={cn(
          ICON_BUTTON,
          "size-11 sm:size-12",
          notesMode && "bg-brand text-white hover:bg-brand"
        )}
        aria-pressed={notesMode}
        aria-label={notesMode ? "Notes on" : "Notes off"}
        title={notesMode ? "Notes on" : "Notes off"}
      >
        <Pencil className="size-5" />
        <span
          className={cn(
            "absolute -top-1 -right-1 rounded-full px-1.5 py-0.5 text-[0.55rem] font-semibold tracking-wide",
            // Inverted against whichever button fill is behind it, so the badge
            // stays legible in both states.
            notesMode ? "bg-white text-brand" : "bg-board-box text-white"
          )}
        >
          {notesMode ? "ON" : "OFF"}
        </span>
      </Button>
    </div>
  );
}