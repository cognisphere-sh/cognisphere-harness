import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { AgentManager } from "../core/agent-manager.js";
import { agentDir } from "../core/config.js";
import type { ServerConfig } from "../core/config.js";

/**
 * /api/agents/:id/fs/* — file tree, read, write, raw download.
 *
 * Every path is validated to stay within the agent's directory: we resolve
 * to an absolute path, normalize it, and reject any result that doesn't have
 * the agent dir as its prefix. The chat UI links into /raw for download/open.
 *
 *   GET    /tree?path=        — directory listing (one level)
 *   GET    /file?path=        — read text file (utf8)
 *   PUT    /file?path=        — write text file (body: { content })
 *   GET    /raw?path=         — raw bytes (download / open)
 *   POST   /upload?dir=       — upload a file (multipart/form-data, field: file)
 *   POST   /mkdir?path=       — create a directory
 *   DELETE /path?path=        — remove a file or directory (recursive)
 *
 * `path` is always relative to the agent dir; "" and "." mean the root.
 */
export function filesRouter(am: AgentManager, cfg: ServerConfig): Hono {
  const r = new Hono();

  r.get("/:id/fs/tree", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.json({ error: "path escapes agent dir" }, 400);
    if (!existsSync(abs)) return c.json({ error: "no such path" }, 404);
    const st = statSync(abs);
    if (!st.isDirectory()) return c.json({ error: "not a directory" }, 400);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        const childAbs = join(abs, e.name);
        const cst = statSync(childAbs);
        return {
          name: e.name,
          path: toRel(root, childAbs),
          isDir: e.isDirectory(),
          size: e.isFile() ? cst.size : 0,
          modified: cst.mtimeMs,
        };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return c.json({ path: toRel(root, abs), entries });
  });

  r.get("/:id/fs/file", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.json({ error: "path escapes agent dir" }, 400);
    if (!existsSync(abs)) return c.json({ error: "no such file" }, 404);
    const st = statSync(abs);
    if (!st.isFile()) return c.json({ error: "not a file" }, 400);
    if (st.size > MAX_TEXT_BYTES) {
      return c.json(
        { error: `file too large to edit (${st.size} > ${MAX_TEXT_BYTES})` },
        413,
      );
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      return c.json({ error: "binary file; use /raw to download" }, 415);
    }
    return c.json({
      path: toRel(root, abs),
      content: buf.toString("utf8"),
      size: st.size,
      modified: st.mtimeMs,
    });
  });

  r.put("/:id/fs/file", async (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.json({ error: "path escapes agent dir" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== "string") {
      return c.json({ error: "missing content" }, 400);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body.content, "utf8");
    const st = statSync(abs);
    return c.json({
      path: toRel(root, abs),
      size: st.size,
      modified: st.mtimeMs,
    });
  });

  r.get("/:id/fs/raw", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.body(null, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.body(null, 400);
    if (!existsSync(abs)) return c.body(null, 404);
    const st = statSync(abs);
    if (!st.isFile()) return c.body(null, 400);
    const data = readFileSync(abs);
    const filename = abs.split(sep).pop() ?? "file";
    const disposition = c.req.query("download")
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`;
    return c.body(new Uint8Array(data), 200, {
      "content-type": guessMime(filename),
      "content-length": String(st.size),
      "content-disposition": disposition,
    });
  });

  r.post("/:id/fs/upload", async (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const relDir = c.req.query("dir") ?? "uploads";
    const absDir = resolveSafe(root, relDir);
    if (!absDir) return c.json({ error: "path escapes agent dir" }, 400);
    mkdirSync(absDir, { recursive: true });
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "expected multipart/form-data" }, 400);
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: 'missing "file" field' }, 400);
    }
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "upload.bin";
    const target = join(absDir, safeName);
    if (!resolveSafe(root, toRel(root, target))) {
      return c.json({ error: "path escapes agent dir" }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(target, new Uint8Array(buf));
    return c.json({
      path: toRel(root, target),
      size: buf.length,
      name: safeName,
    });
  });

  r.post("/:id/fs/mkdir", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.json({ error: "path escapes agent dir" }, 400);
    mkdirSync(abs, { recursive: true });
    return c.json({ path: toRel(root, abs) });
  });

  r.delete("/:id/fs/path", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const root = agentDir(cfg, id);
    const rel = c.req.query("path") ?? "";
    const abs = resolveSafe(root, rel);
    if (!abs) return c.json({ error: "path escapes agent dir" }, 400);
    if (abs === root) return c.json({ error: "cannot delete agent root" }, 400);
    if (!existsSync(abs)) return c.json({ error: "no such path" }, 404);
    const st = statSync(abs);
    rmSync(abs, { recursive: st.isDirectory(), force: false });
    return c.json({ path: toRel(root, abs), isDir: st.isDirectory() });
  });

  return r;
}

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function resolveSafe(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const candidate = normalize(join(root, rel));
  const r = relative(root, candidate);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return candidate;
}

function toRel(root: string, abs: string): string {
  const r = relative(root, abs);
  return r === "" ? "." : r;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 1024));
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) return true;
  }
  return false;
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log"))
    return "text/plain; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}
