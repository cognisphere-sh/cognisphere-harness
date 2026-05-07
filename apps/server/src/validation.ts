import { Ajv, type ErrorObject } from "ajv";
import type { JsonSchema, PluginManifest } from "./types.js";

const ajv = new Ajv({
  useDefaults: true,
  coerceTypes: false,
  allErrors: true,
  strict: false,
});

/**
 * Validate (and default-fill) a plugin config against its manifest's
 * configSchema. Returns the (possibly mutated) config; throws on validation
 * failure. The input object is mutated in place by ajv's `useDefaults`.
 */
export function validateAndDefault(
  schema: JsonSchema,
  config: unknown,
  ctx: { agentId: string; pluginId: string },
): unknown {
  const data = (config ?? {}) as Record<string, unknown>;
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    const msgs =
      validate.errors
        ?.map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ") ?? "unknown";
    throw new Error(
      `config invalid for ${ctx.pluginId} on ${ctx.agentId}: ${msgs}`,
    );
  }
  return data;
}

/**
 * Enforce that every secret declared in `secretsSchema.properties` is
 * populated. v0 contract: all declared secrets are mandatory — there are
 * no optional secrets. The `required` field on `secretsSchema` is ignored
 * (treat every declared key as required).
 */
export function checkRequiredSecrets(
  manifest: PluginManifest,
  resolved: Record<string, string>,
  ctx: { agentId: string; pluginId: string },
): void {
  const declared = Object.keys(manifest.secretsSchema.properties ?? {});
  const missing = declared.filter((k) => !(k in resolved));
  if (missing.length > 0) {
    throw new Error(
      `plugin ${ctx.pluginId} on ${ctx.agentId}: missing secrets: ${missing.join(", ")}`,
    );
  }
}
