# publish-artifact — changelog

## 2.0.0

- **Sharing model replaced.** Artifacts no longer carry a `?k=<token>` link.
  Each has a public/private flag with two URLs — `<app>/private/artifacts/<slug>`
  (signed-in app users; the app's login page is the gate) and
  `<app>/public/artifacts/<slug>` (anyone) — and no URL contains a token.
- The share toggle now lives on the app's protected page, so **any signed-in
  reader can flip the flag**: §4 tells you not to assume the flag you set is
  still current, and to `list` before answering questions about visibility.
- `url --owner` is gone; `url --private` prints the signed-in link.

## 1.1.0

- Explicit responsive rules (mobile-first single column, `.scroll` wrappers for
  wide content, fluid units, tap-target size, no fixed pixel widths) — an
  artifact is now expected to be checked against them before publishing.
- Documented the on-page share toggle and the owner (`?k=`) link.
- Republishing now keeps a slug's visibility as well as its token.

## 1.0.0

- Initial version: when to publish an artifact, the self-contained single-file
  HTML rules, the starter template, private (unlisted token link) vs public
  publishing, sharing, updating in place and taking artifacts down.
