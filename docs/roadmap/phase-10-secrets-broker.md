# Phase 10: secrets broker

[Roadmap](../roadmap.md) · Previous: [Phase 9](phase-09-docker-per-agent.md) · Next: [Phase 11](phase-11-juicefs-and-checkpoints.md)

## Requirement

- **No credentials in the unit:** an agent unit never holds a real credential — not bot tokens, not Google tokens, not model keys. That holds even though capability code and Pi run inside it. So a prompt-injected or buggy agent can't read or leak a key.
- **Harness-owned accounts:** integration accounts are managed by the harness, for example one Google OAuth client with several signed-in accounts. Each agent is granted which accounts it may use and what it may do with them.

## Design

### Connections and grants (coordinator)

- **Connection:** a provider plus an account plus its credentials, such as `telegram:support-bot`, `gws:alice@co.com` or `openai:default`.
  - **Storage:** connections live in the coordinator's secret store. They replace `.secrets/secrets.json` buckets and the GWS-specific OAuth code.
  - **OAuth:** sign-in and callbacks happen at the coordinator, using one redirect URI with PKCE and allow-listed return URLs. This fixes core known issue #15.
- **Grant:** which agent may use a connection, and how. Grants live in `agent.json`, are operator-owned, and are shown in the console.

```json
"grants": [
  { "connection": "gws:alice@co.com", "allow": ["GET gmail.googleapis.com/*", "POST gmail.googleapis.com/*/send"] },
  { "connection": "telegram:support-bot", "allow": ["*"] }
]
```

**Two limits apply:** OAuth scopes chosen at sign-in are the outer limit, enforced by the provider. Grants narrow that per agent, enforced by the proxy. Grant enforcement is real, because the agent never holds the token.

### Placeholders and the egress proxy

- **Placeholders:** the unit's environment gets placeholders, for example `TELEGRAM_BOT_TOKEN=cs-ph:telegram:support-bot`. Capability code and CLIs use them as if they were real.
- **Injection:** outgoing calls go through the coordinator's egress proxy, authenticated with the unit token. The proxy replaces a placeholder with the real value **only when the destination is that connection's allowed host and the agent's grant allows the request**. Elsewhere the placeholder passes through unchanged and is useless.
- **Connector spec:** each capability declares how its connection is injected. This is one generic proxy, not one broker per plugin:

```json
"connector": { "hosts": ["api.telegram.org"], "inject": { "in": "path", "format": "/bot{secret}/" } }
"connector": { "hosts": ["*.googleapis.com"], "auth": { "type": "oauth2", "...": "..." },
               "inject": { "in": "header", "name": "Authorization", "format": "Bearer {access_token}" } }
```

**How traffic reaches the proxy:**

- **Base-URL mode:** the capability or SDK points at `http://<coordinator>/egress/<connection>/…`. No TLS tricks are needed. This is the first choice for our own capabilities and for Pi's model providers.
- **TLS interception:** set `HTTPS_PROXY` and add the coordinator's CA to the image. This is for third-party CLIs that can't change their base URL.

**Model calls:** Pi's provider config inside the unit points `baseUrl` at the proxy, with the placeholder as the API key. The coordinator uses the real key, or a fresh OAuth access token, and enforces the shared model check.

**Coverage:**

- **Covered:** API keys in a header, query or path; bearer tokens; basic auth; OAuth2; client certificates.
- **Not covered:** request signing (AWS SigV4, HMAC) needs a small trusted signing hook. Non-HTTP protocols (SMTP, SSH, databases) need either a trusted coordinator action, or an operator-marked secret that is "exposed to the agent".

**Audit:** the proxy logs every credentialed request per agent (method, host, path).

### Auth backend: deferred

Connections sit behind a `CredentialBackend` interface: get a credential, refresh it, start a sign-in, finish a sign-in. This phase ships a **built-in** backend: API keys and bot tokens, plus OAuth for GWS and the model subscriptions. Composio, Nango or another provider can be added later as another backend, without changing units or grants.

## Done when

- **No secrets inside:** a Docker agent uses Telegram, GWS, agent messaging and model calls with no real secret anywhere in its environment or files. Check with `env` and `grep -r` inside the container.
- **Proxy checks:**
  - a placeholder sent to another host is not replaced;
  - a request outside the agent's grant is refused;
  - an expired unit token is rejected.
- **Model calls:** they work through the proxy for one API-key provider and one subscription provider (Codex or Claude Pro).
- **Migration:** existing secrets and GWS sign-ins are migrated, and the old plaintext buckets are removed from active config.
- **Docs:**
  - HLD (trust boundary);
  - plugins.md (connector spec);
  - api.md (connections, grants, egress);
  - core.md (known issues #9, #14 and #15 marked Fixed);
  - shipped README.

## Open questions

1. **Pi subscription providers:** they refresh their own tokens from `auth.json`. A spike must confirm that a placeholder token with a far-future expiry works. Fallback: API-key providers only for Docker agents at first.
2. **Agent-level secrets** (for example a TTS key used by agent scripts): should they become connections with a connector spec, or be explicitly marked "exposed to the agent"?
3. **Unchanged forked plugins:** should forked plugins that haven't been updated still get real secrets, through a per-plugin compatibility flag with a console warning?
