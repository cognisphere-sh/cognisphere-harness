import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { findProviderInCatalog } from "./models-catalog.js";
import type { ModelsStore } from "./models-store.js";
import type { CredField, ProviderCatalogEntry } from "./types.js";

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

/**
 * A provider can authenticate when its required credentials are stored or a
 * subscription sign-in is connected (tokens live in pi's own auth.json).
 * OAuth-only providers (no credential fields) need the sign-in.
 */
export function providerAuthenticated(
  entry: ProviderCatalogEntry,
  stored: Record<string, string>,
): boolean {
  const oauthConnected =
    entry.oauth === true && readStoredCredential(entry.id)?.type === "oauth";
  if (entry.credentials.length === 0) return oauthConnected;
  return oauthConnected || requiredCredentialsPresent(entry.credentials, stored);
}

/**
 * Why `providerId/modelId` can't be used right now, or null if it can. The one
 * rule shared by agent startup, the thread-model endpoint and every batch
 * spawn. Providers outside the catalog pass through: pi resolves them from the
 * ambient environment.
 */
export function modelUnavailableReason(
  models: ModelsStore,
  providerId: string,
  modelId: string,
): string | null {
  const entry = findProviderInCatalog(providerId);
  if (!entry) return null;
  const cfg = models.getProvider(providerId);
  if (!providerAuthenticated(entry, cfg?.credentials ?? {})) {
    return `provider ${providerId} has no credentials or sign-in in Models settings`;
  }
  if (!cfg?.enabledModels.includes(modelId)) {
    return `model ${providerId}/${modelId} is not enabled in Models settings`;
  }
  return null;
}
