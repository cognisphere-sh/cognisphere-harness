# read-email — changelog

## 1.1.0

- §4 now points at `scripts/gws/email search` instead of raw
  `gws gmail users messages list` — searching, narrowing a query and filing
  results moved to the `search-email` skill, which this one now names.

## 1.0.0

- Initial version: reading a full body with `scripts/gws/email read`, quoted
  reply history (`--strip-quotes`), skimming a thread before fetching
  (`email thread`), reaching older / Cc-only messages, downloading and
  converting attachments, and searching for mail the poller never delivered.
