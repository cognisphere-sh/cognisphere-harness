import { Ajv, type ErrorObject } from "ajv";
import type { JsonSchema } from "./types.js";

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
 * Enforce that every secret declared in `schema.properties` is populated.
 * v0 contract: all declared secrets are mandatory — there are no optional
 * secrets. The `required` field on the schema is ignored (treat every
 * declared key as required).
 *
 * `label` is rendered in the error message — pass `"plugin <pluginId> on
 * <agentId>"` for plugin secrets or `"agent <agentId>"` for agent-level
 * secrets.
 */
export function checkRequiredSecrets(
  schema: JsonSchema | undefined,
  resolved: Record<string, string>,
  label: string,
): void {
  if (!schema) return;
  const declared = Object.keys(schema.properties ?? {});
  const missing = declared.filter((k) => !(k in resolved));
  if (missing.length > 0) {
    throw new Error(`${label}: missing secrets: ${missing.join(", ")}`);
  }
}
