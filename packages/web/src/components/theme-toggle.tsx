import { Moon, Sun } from "lucide-react";
import { motion } from "framer-motion";
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
      <motion.div
        key={theme}
        initial={{ rotate: -45, opacity: 0 }}
        animate={{ rotate: 0, opacity: 1 }}
        transition={{ duration: 0.18 }}
        className="flex"
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </motion.div>
    </Button>
  );
}
