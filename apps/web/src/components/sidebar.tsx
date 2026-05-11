import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Bot,
  ChevronRight,
  LogOut,
  Menu,
  Moon,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { endpoints } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function Sidebar() {
  const { id } = useParams<{ id: string }>();
  const { user, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["agents"],
    queryFn: endpoints.listAgents,
    refetchInterval: 30_000,
  });

  // Close drawer on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [id]);

  const onLogout = async () => {
    await logout();
    navigate("/login");
  };

  const drawer = (
    <aside
      className={cn(
        "flex h-full w-64 max-w-[85vw] flex-col border-r border-border bg-card",
        "shrink-0",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">pi-harness</div>
            <div className="text-[10px] text-muted-foreground">v0</div>
          </div>
        </Link>
        <button
          aria-label="close menu"
          onClick={() => setMobileOpen(false)}
          className="md:hidden"
        >
          <X className="size-4" />
        </button>
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </div>
        <ul className="flex flex-col gap-1">
          {data?.agents.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              No agents loaded. Create one under{" "}
              <code className="rounded bg-muted px-1">~/.piharness/default/agents/</code>{" "}
              and restart the server.
            </li>
          )}
          {data?.agents.map((a) => (
            <li key={a.id}>
              <NavLink
                to={`/agents/${a.id}`}
                end={false}
                className={({ isActive }) =>
                  cn(
                    "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-foreground/80 hover:bg-accent hover:text-foreground",
                  )
                }
              >
                <Bot className="size-4 opacity-70" />
                <span className="truncate">{a.name}</span>
                <ChevronRight className="ml-auto size-4 opacity-0 group-hover:opacity-50 transition-opacity" />
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
      <Separator />
      <div className="flex flex-col gap-1 p-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-primary/10 text-primary font-medium"
                : "text-foreground/80 hover:bg-accent",
            )
          }
        >
          <Settings className="size-4" />
          Settings
        </NavLink>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent"
          aria-label={`switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <Button variant="ghost" className="justify-start" onClick={onLogout}>
          <LogOut className="size-4" />
          Sign Out
        </Button>
        <Separator className="my-1" />
        <div className="flex items-center gap-2.5 rounded-md px-3 py-2">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-xs font-semibold text-white">
            {initials(user)}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium">{user ?? "—"}</div>
            <div className="truncate text-xs text-muted-foreground">
              Signed in
            </div>
          </div>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden md:flex">{drawer}</div>
      <div className="md:hidden">
        <button
          aria-label="open menu"
          className="fixed left-3 top-3 z-30 grid size-9 place-items-center rounded-md border bg-card shadow-card"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="size-4" />
        </button>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-40 flex"
          >
            <motion.div
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: "tween", duration: 0.18 }}
              className="h-full"
            >
              {drawer}
            </motion.div>
            <div
              className="flex-1 bg-background/70 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
          </motion.div>
        )}
      </div>
    </>
  );
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
