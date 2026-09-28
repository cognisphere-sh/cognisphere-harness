# Plan 2: read-only session search

**Status:** later planned feature. **Delivery:** M13 in the [roadmap](../roadmap.md#2-session-search). **Depends on:** Pi-owned session files from [the directory/runtime foundation](02-workspace-and-provisioning.md#pi-owned-sessions) and authorized read access. No archive backend, database copy of JSONL or memory subsystem is required. **Layers:** core, API and web.

## Scope

Search existing Pi session files without taking over their lifecycle. Pi remains the only session writer. Start with an authorized bounded file reader and source-linked search results; add a disposable text index only when measured scale warrants it. Do not implement memory extraction, recall injection, embeddings, memory hooks or a second authoritative transcript store.

The index, if added, contains derived searchable text and source references; it is rebuilt from mounted files and is not used to resume Pi. The runtime continues to work when search/indexing is unavailable. Search does not block the first agent/sandbox release.

## Read path and identity

1. Authorize agent/thread/role scope before enumerating paths, returning counts or reading entries. Resolve known logical-session-to-Pi-file mappings; reject traversal and symlink escapes.
2. Read a bounded prefix/file view and parse supported Pi entries without modifying source bytes. Skip an incomplete trailing line while Pi appends and retry it later; surface malformed historical content rather than repair it.
3. Link results to agent, logical session, Pi file/session ID and entry ID. Include a content fingerprint/read watermark to detect file changes, compaction or replacement; revalidate the reference before showing a source excerpt.
4. Apply query, time, result-size and pagination limits. An expired/changed search snapshot requires a fresh query rather than silently skipping or duplicating matches.
5. If an optional index exists, reconcile changed/deleted sources and authorize queries independently. Do not resurrect removed content from stale indexing jobs; rebuild from the current files.

The UI reads session entries for inspection; it never rewrites JSONL or stores raw archive revisions. A reviewer may cite authorized source entries, with unavailable/stale evidence shown explicitly. Search results are evidence, not instructions to execute.

## Acceptance

Verify scoped results and counts, source links, bounded reads, stable pagination or explicit restart, concurrent Pi appends, incomplete trailing lines, changed/compacted/deleted files and stale-index cleanup. Search failure must not affect Pi execution/resume. No session write, archive copy or memory preparation/finalization is introduced.
