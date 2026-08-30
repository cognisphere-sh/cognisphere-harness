"use client";

import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: f.get("username"), password: f.get("password") }),
    });
    if (!r.ok) return setError("Invalid credentials");
    location.href = new URLSearchParams(location.search).get("next") ?? "/";
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 320, margin: "10vh auto", display: "grid", gap: 8 }}>
      <input name="username" placeholder="Username" autoComplete="username" required />
      <input name="password" type="password" placeholder="Password" autoComplete="current-password" required />
      <button type="submit">Sign in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
