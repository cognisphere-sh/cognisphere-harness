import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { setUnauthenticatedHandler } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { IndexPage } from "@/pages/index";
import { AgentPage } from "@/pages/agent";
import { SettingsPage } from "@/pages/settings";
import { ModelsPage } from "@/pages/models";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
          <AuthBoot>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                  <Route path="/" element={<IndexPage />} />
                  <Route path="/agents/:id/*" element={<AgentPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/settings/models" element={<ModelsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Route>
            </Routes>
          </AuthBoot>
        </BrowserRouter>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} richColors position="top-right" />;
}

function AuthBoot({ children }: { children: React.ReactNode }) {
  const { refresh, status } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Wire 401 redirects on the api fetcher.
  useEffect(() => {
    setUnauthenticatedHandler(() => navigate("/login", { replace: true }));
    return () => setUnauthenticatedHandler(null);
  }, [navigate]);

  if (status === "unknown") {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        loading…
      </div>
    );
  }
  return <>{children}</>;
}

function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status !== "authed") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  // Outlet is rendered inside the nested route via react-router.
  return <RouteOutlet />;
}

import { Outlet } from "react-router-dom";
function RouteOutlet() {
  return <Outlet />;
}
