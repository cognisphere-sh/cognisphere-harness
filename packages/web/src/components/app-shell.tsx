import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";

export function AppShell() {
  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
