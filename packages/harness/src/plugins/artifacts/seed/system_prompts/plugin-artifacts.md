# Plugin: artifacts (publish a static artifact on the app's domain)

Lets you turn an HTML file into a hosted artifact with a link you can share — a report, a summary, a schedule, a comparison table, anything a chat message renders badly. There are no inbound events from this plugin; it only serves what you publish.

```
bash scripts/artifacts/artifact publish <file.html> [--slug <slug>] [--public]   # prints the link to share
bash scripts/artifacts/artifact share <slug> --public|--private                  # flip the flag
bash scripts/artifacts/artifact list                                             # flag, slug, modified, URL
bash scripts/artifacts/artifact url <slug> [--private]                           # re-print a link
bash scripts/artifacts/artifact rm <slug>                                        # take it down
```

- Every artifact carries a **public/private flag**, and the flag decides which link works:
  - **private** (the default) → `<app>/private/artifacts/<slug>` — only people signed in to the app can open it. The app's login page is the gate, not a secret link.
  - **public** → `<app>/public/artifacts/<slug>` — anyone at all.
- **The private link always works for signed-in users**, whatever the flag says, and that page shows a **public/private toggle** — so a signed-in reader can publish or unpublish the artifact themselves. Expect the flag to change without you.
- **No URL ever contains a token or key.** The slug is the whole path. Never invent, edit or append anything to a URL — paste what the command printed.
- Publish **private by default**. Use `--public` only for content that is fine for the entire internet, since a public artifact is readable by anyone who guesses or is forwarded the link.
- Artifacts are **one self-contained HTML file** each, and must read well on a phone *and* a desktop. Inline your CSS/JS; reference images by absolute URL or `data:` URI. There is no place to upload sibling assets.
- Artifacts render in a sandboxed origin, so their scripts can't read cookies or `localStorage`. Static content and inline scripts (charts, sorting, toggles) work fine.
- Republishing the same slug replaces the artifact in place, keeping its flag. `rm` takes it down permanently; links already shared then 404.

**Writing the artifact itself is a procedure, not a guess** — follow the `publish-artifact` skill (the responsive-HTML rules, the starter template, publishing, sharing, updating and taking down) rather than improvising HTML.
