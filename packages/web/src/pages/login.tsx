import { useState } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Bot, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth";

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target =
    (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  if (status === "authed") return <Navigate to={target} replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate(target, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-full min-h-dvh w-full items-center justify-center bg-background p-4">
      <div className="absolute right-3 top-3 z-10">
        <ThemeToggle />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-sm"
      >
        <Card className="overflow-hidden">
          <CardHeader className="items-center text-center">
            <div className="mb-2 grid size-10 place-items-center rounded-md bg-primary text-primary-foreground">
              <Bot className="size-5" />
            </div>
            <CardTitle>CogniSphere</CardTitle>
            <CardDescription>Sign in to manage your agents</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="u">Username</Label>
                <Input
                  id="u"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p">Password</Label>
                <Input
                  id="p"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Sign in
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Default: <code>admin</code> / <code>changeme</code>. Edit{" "}
                <code>~/.cognisphere/default/.secrets/users.json</code> to change.
              </p>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
