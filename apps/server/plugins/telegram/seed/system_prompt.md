# Plugin: telegram (stub)

This plugin is a **stub** in v1. It receives inbound POSTs at its webhook
URL and emits `message_received`, but the outbound `send` path is not
implemented. To send replies, ask the operator to finish the plugin or
write a custom one.

When a user message arrives the harness-metadata block will include:
- `Plugin: telegram`
- `Channel: <chat-id>`

You can read the full inbound body in your session JSONL if you need it.
