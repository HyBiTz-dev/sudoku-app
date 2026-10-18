"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // `resolvedTheme` is only read inside the handler, which runs on the
      // client, so there is no need to wait for hydration to pick an icon.
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
      className="text-board-given hover:bg-board-peer"
    >
      {/* Both icons render; the `dark` class on <html> decides which shows, so
          the server and client markup always match. */}
      <Moon className="dark:hidden" />
      <Sun className="hidden dark:block" />
    </Button>
  );
}