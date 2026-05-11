import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Minimal JSON-Schema form renderer. Drives both plugin/agent config and
 * secrets editing — see `<SecretsForm>` for the secrets-specific top-level
 * (password inputs, mask placeholders, sentinel-clear). Supported keywords:
 *
 *   type:      object, string, integer, number, boolean, array
 *   enum:      on string ⇒ dropdown
 *   minimum/maximum:  on number/integer ⇒ input bounds
 *   items:     on array (only `items.type === "string"` ⇒ chip list)
 *   description, default
 *
 * Anything outside this set falls back to a raw JSON textarea so you don't
 * lose the data, just the form ergonomics. Nested objects render
 * recursively as collapsible groups so deeply-nested configs (model,
 * threadIdStrategy) stay legible.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (!isObjectSchema(schema)) {
    return <JsonFallback value={value} onChange={onChange} />;
  }
  return (
    <ObjectFields
      schema={schema}
      value={isPlainObject(value) ? value : {}}
      onChange={onChange}
    />
  );
}

function ObjectFields({
  schema,
  value,
  onChange,
  depth = 0,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  depth?: number;
}) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return (
      <Badge variant="outline" className="w-fit">
        no fields declared
      </Badge>
    );
  }
  return (
    <div className={cn("grid gap-3", depth === 0 && "sm:grid-cols-2")}>
      {keys.map((k) => {
        const sub = props[k]!;
        const subType = primaryType(sub);
        const isFullWidth =
          subType === "object" ||
          subType === "array" ||
          (subType === "string" && (sub.description?.length ?? 0) > 60);
        return (
          <div
            key={k}
            className={cn("flex flex-col gap-1.5", isFullWidth && "sm:col-span-2")}
          >
            <FieldLabel name={k} schema={sub} required={required.has(k)} />
            <SchemaField
              schema={sub}
              value={value[k]}
              onChange={(v) => onChange({ ...value, [k]: v })}
              depth={depth + 1}
            />
          </div>
        );
      })}
    </div>
  );
}

function FieldLabel({
  name,
  schema,
  required,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
}) {
  return (
    <div className="flex flex-col">
      <Label className="font-mono text-xs">
        {name}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {schema.description && (
        <span className="text-[11px] text-muted-foreground">
          {schema.description}
        </span>
      )}
    </div>
  );
}

// ── field switch ────────────────────────────────────────────────────

function SchemaField({
  schema,
  value,
  onChange,
  depth,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  depth: number;
}) {
  const t = primaryType(schema);

  if (Array.isArray(schema.enum)) {
    return (
      <EnumField
        options={schema.enum.map(String)}
        value={value == null ? "" : String(value)}
        onChange={(s) => onChange(coerceForEnum(schema, s))}
      />
    );
  }

  if (t === "boolean") {
    return (
      <BooleanField
        value={!!value}
        onChange={onChange}
      />
    );
  }
  if (t === "integer" || t === "number") {
    return (
      <NumberField
        schema={schema}
        value={value as number | undefined | null}
        onChange={onChange}
        integer={t === "integer"}
      />
    );
  }
  if (t === "string") {
    return (
      <StringField
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
      />
    );
  }
  if (t === "array" && schema.items?.type === "string") {
    return (
      <StringArrayField
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={onChange}
      />
    );
  }
  if (t === "object") {
    // No declared properties but an `additionalProperties` schema (e.g. a
    // free-form `Record<string, string>` map like agent.json's `config`):
    // fall through to a raw-JSON editor since the structured form has no
    // way to render arbitrary keys.
    const hasNoProps =
      !schema.properties || Object.keys(schema.properties).length === 0;
    const hasAdditional =
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false;
    if (hasNoProps && hasAdditional) {
      return <JsonFallback value={value} onChange={onChange} />;
    }
    return (
      <NestedObjectField
        schema={schema}
        value={isPlainObject(value) ? value : {}}
        onChange={onChange}
        depth={depth}
      />
    );
  }
  return <JsonFallback value={value} onChange={onChange} />;
}

// ── primitives ──────────────────────────────────────────────────────

function StringField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono text-xs"
    />
  );
}

function NumberField({
  schema,
  value,
  onChange,
  integer,
}: {
  schema: JsonSchema;
  value: number | undefined | null;
  onChange: (v: number | undefined) => void;
  integer: boolean;
}) {
  return (
    <Input
      type="number"
      value={value === undefined || value === null ? "" : value}
      step={integer ? 1 : "any"}
      min={schema.minimum}
      max={schema.maximum}
      onChange={(e) => {
        const s = e.target.value;
        if (s === "") return onChange(undefined);
        const n = integer ? Number.parseInt(s, 10) : Number.parseFloat(s);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
      className="font-mono text-xs"
    />
  );
}

function BooleanField({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent/40">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      <span>{value ? "true" : "false"}</span>
    </label>
  );
}

function EnumField({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-8 font-mono text-xs shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        )}
      >
        {!options.includes(value) && <option value="">— select —</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function StringArrayField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...value, v]);
    setDraft("");
  };
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add an entry…"
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={add}
          aria-label="add"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span
              key={`${v}-${i}`}
              className="inline-flex items-center gap-1 rounded-md border bg-secondary px-2 py-0.5 font-mono text-[11px]"
            >
              {v}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`remove ${v}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function NestedObjectField({
  schema,
  value,
  onChange,
  depth,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  depth: number;
}) {
  // Render nested object as a bordered group so the visual nesting matches
  // the data nesting. No collapsing for v0 — keeps things visible.
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <ObjectFields
        schema={schema}
        value={value}
        onChange={onChange}
        depth={depth}
      />
    </div>
  );
}

function JsonFallback({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        rows={4}
        className="block w-full rounded-md border bg-background px-2 py-1 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      />
      {error && (
        <p className="mt-1 text-[11px] text-destructive">invalid JSON: {error}</p>
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function primaryType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== "null");
  }
  return schema.type;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return primaryType(schema) === "object" || !!schema.properties;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function coerceForEnum(schema: JsonSchema, raw: string): unknown {
  const t = primaryType(schema);
  if (raw === "") return undefined;
  if (t === "integer") return Number.parseInt(raw, 10);
  if (t === "number") return Number.parseFloat(raw);
  if (t === "boolean") return raw === "true";
  return raw;
}
