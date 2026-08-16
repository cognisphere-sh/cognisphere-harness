---
name: publish-artifact
description: Author and publish a static HTML artifact hosted on the app's own domain, and share its link. Covers when an artifact beats a chat message, the responsive single-file HTML rules (mobile + desktop) and the starter template in artifacts/template.html, the public/private flag and its two URLs (signed-in app users vs anyone), the toggle signed-in readers can flip, sharing, updating in place, and taking one down with `scripts/artifacts/artifact`. Use when asked to "make a page", "publish this", "share a report/summary/dashboard as a link", "send me a link instead", or when a reply is too long, too tabular or too visual for a chat message. (v2.0.0)
metadata:
  author: cognisphere
  version: "2.0.0"
---

# Publish an artifact

Provided by the `artifacts` plugin. An artifact is **one HTML file** you write,
published under the app's domain, that you then share as a link.

## 1. Decide whether an artifact is right

Reach for one when the answer is a *document*: a long report, a table wider than
a few columns, a comparison, a chart, a checklist someone will keep coming back
to, a summary meant to be forwarded to a person who isn't in this conversation.
Reach for a normal reply when the answer is a sentence or two — a link to three
lines of text is worse than the three lines.

## 2. Write the file

Start from `artifacts/template.html` (copy it into your workspace and edit it):

```bash
cp skills/artifacts/publish-artifact/artifacts/template.html workspace/q3-summary.html
```

### It must work on a phone *and* a desktop

Most artifacts are opened on a phone, from a chat message. Assume that first,
and make sure it still reads well in a wide window.

- **One fluid column, no fixed widths.** `max-width` in `rem` + `margin:auto`
  (the template does this). Never set a pixel `width` on a container, never rely
  on a viewport wider than **360px**.
- **The body must not scroll sideways.** Anything intrinsically wide — tables,
  code blocks, wide charts — goes inside a `<div class="scroll">`
  (`overflow-x:auto`), so *it* scrolls, not the page.
- **Images and embeds:** `max-width:100%; height:auto`. No fixed pixel heights.
- **Tap targets ≥ 2.75rem** for anything clickable, with real spacing between
  them; hover-only affordances don't exist on a phone.
- **No side-by-side layout below ~40rem.** If you use columns, use
  `display:grid` with `grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))`
  so they collapse by themselves — not a media query per breakpoint.
- **Keep the viewport meta tag** the template ships with. (The plugin injects one
  if it's missing, but write it — you shouldn't rely on the safety net.)
- Check your own markup before publishing: any `width:`/`height:` in `px`, any
  table not wrapped in `.scroll`, any `font-size` under `0.85rem` is a bug.

### It must be self-contained

- **One file.** Inline all CSS and JS. There is no place to upload a sibling
  `style.css` or `logo.png`. Images are either an absolute `https://` URL or a
  `data:` URI.
- **Sandboxed origin.** Scripts run, but `document.cookie`, `localStorage` and
  same-origin `fetch` to the app do not. Anything the artifact shows must already
  be *in* the file — inline data as a JS literal if a script needs it.
- **Write the date and your source into the artifact.** A shared link outlives
  the conversation that produced it; a reader six weeks later needs to know what
  the numbers are as-of.

## 3. Publish

```bash
bash scripts/artifacts/artifact publish workspace/q3-summary.html            # private (default)
bash scripts/artifacts/artifact publish workspace/q3-summary.html --public   # open to anyone
```

It prints the URL. That URL is the deliverable — paste it as-is. **No artifact
URL ever contains a token or key**: the slug is the whole path, so there is
never anything to append, edit or assemble by hand.

Every artifact carries a **public/private flag**, and the flag decides which of
its two links works:

| Flag | Link | Who can open it |
|---|---|---|
| **private** (default) | `<app>/private/artifacts/q3-summary` | only people signed in to the app — its login page is the gate |
| **public** | `<app>/public/artifacts/q3-summary` | anyone at all |

Publish private unless the content is fit for the entire internet: a public
artifact is readable by anyone who is forwarded or guesses the link, and there
is no second barrier behind it.

`--slug <slug>` overrides the URL slug (default: derived from the filename).
Pick a slug that is a stable name for the *thing*, not the date — you will be
republishing to it.

## 4. Share it, and who can change the flag

Send the link on whatever channel you're already talking on, with one line of
context: what it is and how fresh it is. Don't also paste the whole content —
the link exists so you don't have to.

**The private link always works for signed-in users**, whatever the flag says,
and that page carries a **public/private toggle** as part of the app's own
chrome. So a signed-in reader can publish or unpublish the artifact without
you: don't assume the flag you set is still the flag it has — `list` before you
answer questions about who can see something.

```bash
bash scripts/artifacts/artifact url q3-summary             # the link to hand out
bash scripts/artifacts/artifact url q3-summary --private   # the signed-in link (with the toggle)
bash scripts/artifacts/artifact share q3-summary --public   # publish it yourself
bash scripts/artifacts/artifact share q3-summary --private  # unpublish it
```

Send a colleague the `--private` link when they should be able to control
sharing; send the plain link when they just need to read it.

## 5. Update or take down

Publish the same slug again to replace it in place — same URL, same flag:

```bash
bash scripts/artifacts/artifact publish workspace/q3-summary.html
```

An update is instantly visible to everyone who can open the link. Re-check the
content is still fit for all of them before republishing — and check the flag
first if it might have been flipped to public since you last looked.

```bash
bash scripts/artifacts/artifact list       # flag, slug, last modified, URL
bash scripts/artifacts/artifact rm <slug>  # permanent; shared links start 404ing
```

Take artifacts down when they go stale — an old artifact with a live link is a
wrong answer waiting to be read.

## Failure modes

- `bad slug '…'` — slugs are lowercase letters, digits and dashes, ≤64 chars.
  Pass an explicit `--slug`.
- `published, but the plugin didn't return a URL` — the file was written but the
  harness didn't answer. It is not shareable; report that rather than guessing a
  URL.
- `no such file` — publish the path you actually wrote, relative to the agent
  dir.
- `no artifact '<slug>'` from `share`/`url`/`rm` — check `list` for the real slug.
- A reader says the link asks them to sign in — that artifact is private and
  they have no app account. Either they get one, or you flip it to `--public`
  (only if the content is fit for anyone).
