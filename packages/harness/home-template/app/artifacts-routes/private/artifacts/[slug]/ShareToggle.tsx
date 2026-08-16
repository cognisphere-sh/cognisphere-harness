"use client";

/**
 * The share toggle: the app's own chrome above the artifact iframe. Same-origin
 * POST, so the session cookie travels; the harness secret stays server-side in
 * the /share route.
 */
import { useState } from "react";
import type { ArtifactInfo } from "@/lib/artifacts";

export default function ShareToggle({
  slug,
  initial,
}: {
  slug: string;
  initial: ArtifactInfo;
}) {
  const [info, setInfo] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isPublic = info.visibility === "public";

  async function flip() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/private/artifacts/${slug}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ public: !isPublic }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setInfo((await r.json()) as ArtifactInfo);
    } catch {
      setError("Could not change sharing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: ".5rem",
        padding: ".6rem clamp(.75rem, 3vw, 1.25rem)",
        borderBottom: "1px solid rgba(128,128,128,.3)",
        font: '500 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <strong style={{ marginRight: "auto" }}>{slug}</strong>
      <button
        type="button"
        onClick={flip}
        disabled={busy}
        aria-pressed={isPublic}
        title={
          isPublic
            ? "Anyone with the link can read this. Click to make it private."
            : "Only signed-in users can read this. Click to publish it."
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: ".45rem",
          minHeight: "2.75rem",
          padding: "0 .9rem",
          border: 0,
          borderRadius: "999px",
          background: isPublic ? "#1f7a4d" : "#2b3441",
          color: "#fff",
          font: "inherit",
          cursor: busy ? "progress" : "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: ".6rem",
            height: ".6rem",
            borderRadius: "50%",
            background: isPublic ? "#8ff0b8" : "#8b95a3",
          }}
        />
        {isPublic ? "Public" : "Private"}
      </button>
      <input
        readOnly
        aria-label="Link to share"
        value={info.url}
        onClick={(e) => e.currentTarget.select()}
        style={{
          flex: "1 1 14rem",
          minWidth: 0,
          minHeight: "2.75rem",
          padding: "0 .7rem",
          border: "1px solid rgba(128,128,128,.4)",
          borderRadius: "999px",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textOverflow: "ellipsis",
        }}
      />
      {error && <span style={{ color: "#c0392b", flexBasis: "100%" }}>{error}</span>}
    </header>
  );
}
