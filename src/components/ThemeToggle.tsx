import { Moon, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      className="relative overflow-hidden"
    >
      <span
        key={theme}
        className="inline-flex"
        style={{ animation: "theme-icon-in 350ms cubic-bezier(0.22, 1, 0.36, 1)" }}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </span>
    </Button>
  );
}
