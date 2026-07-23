import type { CredField } from "../core/types.js";

/**
 * Shared credential masking/merge helpers for /api/models and /api/secrets.
 *
 * Secret values never round-trip to the client: GET responses replace set
 * values with MASK, and PUTs use sentinel semantics — `null` deletes a key,
 * MASK leaves the existing value untouched, any other string sets it.
 */

export const MASK = "********";

/** GET-side display value: "" if unset, MASK if secret, plain otherwise. */
export function maskCredential(v: unknown, secret: boolean): string {
  if (typeof v !== "string" || v.length === 0) return "";
  return secret ? MASK : v;
}

/** PUT-side merge: `null` deletes, MASK keeps the existing value, a string sets. */
export function applyMaskedPut(
  target: Record<string, string>,
  key: string,
  v: string | null,
): void {
  if (v === null) delete target[key];
  else if (v === MASK) {
    // unchanged — keep existing value
  } else if (typeof v === "string") target[key] = v;
}

/** Every required credential field has a non-empty stored value. */
export function requiredCredentialsPresent(
  fields: CredField[],
  stored: Record<string, string>,
): boolean {
  return fields
    .filter((f) => f.required)
    .every((f) => {
      const v = stored[f.key];
      return typeof v === "string" && v.length > 0;
    });
}
