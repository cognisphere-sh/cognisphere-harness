/**
 * Server-side harness client. Authenticates the *app* with the bearer from
 * app/.env.local and asserts the acting user via `X-App-User`. Never call
 * from the browser — the bearer has full operator access, so every route
 * that uses this must gate on `getUser()` first and allowlist what it proxies.
 */
export function harness(path: string, user: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${process.env.HARNESS_URL ?? "http://127.0.0.1:3142"}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${process.env.HARNESS_APP_SECRET}`,
      "x-app-user": user,
    },
  });
}
