import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={`switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      <div key={theme} className="flex animate-in fade-in spin-in-45 duration-200">
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </div>
    </Button>
  );
}
