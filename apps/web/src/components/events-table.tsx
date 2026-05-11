import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { endpoints, type EventRow, type EventStatus } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PAGE_SIZE = 100;

const STATUSES: EventStatus[] = [
  "queued",
  "in_flight",
  "done",
  "failed",
  "cancelled",
];

type SortBy = "ts" | "updated_at" | "status" | "plugin_id" | "thread_id";
type SortDir = "asc" | "desc";

interface Props {
  agentId: string;
}

export function EventsTable({ agentId }: Props) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<EventStatus[]>([]);
  const [plugin, setPlugin] = useState<string>("");
  const [silentOnly, setSilentOnly] = useState(false);
  const [tsFrom, setTsFrom] = useState<string>("");
  const [tsTo, setTsTo] = useState<string>("");
  const [updatedFrom, setUpdatedFrom] = useState<string>("");
  const [updatedTo, setUpdatedTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortBy>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [offset, setOffset] = useState(0);

  // debounce the search input by 300ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // reset paging when filters/sort change
  useEffect(() => {
    setOffset(0);
  }, [
    search,
    statuses,
    plugin,
    silentOnly,
    tsFrom,
    tsTo,
    updatedFrom,
    updatedTo,
    sortBy,
    sortDir,
  ]);

  const params = {
    status: statuses.length ? statuses : undefined,
    plugin: plugin || undefined,
    search: search || undefined,
    isSilent: silentOnly ? true : undefined,
    tsFrom: localToMs(tsFrom),
    tsTo: localToMs(tsTo),
    updatedFrom: localToMs(updatedFrom),
    updatedTo: localToMs(updatedTo),
    sortBy,
    sortDir,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["events", agentId, params],
    queryFn: () => endpoints.listEvents(agentId, params),
    refetchInterval: 2_000,
    placeholderData: keepPreviousData,
  });

  const rows = data?.events ?? [];
  const total = data?.total ?? 0;

  const pluginOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.pluginId);
    return [...set].sort();
  }, [rows]);

  const toggleStatus = (s: EventStatus) => {
    setStatuses((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  };

  const onSort = (col: SortBy) => {
    if (col === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  const anyRangeSet = !!(tsFrom || tsTo || updatedFrom || updatedTo);
  const clearRanges = () => {
    setTsFrom("");
    setTsTo("");
    setUpdatedFrom("");
    setUpdatedTo("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Toolbar
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        statuses={statuses}
        onToggleStatus={toggleStatus}
        plugin={plugin}
        pluginOptions={pluginOptions}
        onPluginChange={setPlugin}
        silentOnly={silentOnly}
        onSilentOnly={setSilentOnly}
      />

      <RangeFilters
        tsFrom={tsFrom}
        tsTo={tsTo}
        updatedFrom={updatedFrom}
        updatedTo={updatedTo}
        onTsFrom={setTsFrom}
        onTsTo={setTsTo}
        onUpdatedFrom={setUpdatedFrom}
        onUpdatedTo={setUpdatedTo}
        anyRangeSet={anyRangeSet}
        onClear={clearRanges}
      />

      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <table className="w-full min-w-max text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b text-left">
              <Th>#</Th>
              <SortableTh col="ts" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                Created
              </SortableTh>
              <SortableTh
                col="updated_at"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              >
                Updated
              </SortableTh>
              <SortableTh
                col="status"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              >
                Status
              </SortableTh>
              <SortableTh
                col="plugin_id"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              >
                Plugin
              </SortableTh>
              <Th>Channel</Th>
              <SortableTh
                col="thread_id"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              >
                Thread
              </SortableTh>
              <Th>Silent</Th>
              <Th>Text</Th>
              <Th>Metadata</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} agentId={agentId} row={r} />
            ))}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No events match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager total={total} offset={offset} pageSize={PAGE_SIZE} onChange={setOffset} />
    </div>
  );
}

function Toolbar({
  searchInput,
  onSearchInput,
  statuses,
  onToggleStatus,
  plugin,
  pluginOptions,
  onPluginChange,
  silentOnly,
  onSilentOnly,
}: {
  searchInput: string;
  onSearchInput: (s: string) => void;
  statuses: EventStatus[];
  onToggleStatus: (s: EventStatus) => void;
  plugin: string;
  pluginOptions: string[];
  onPluginChange: (p: string) => void;
  silentOnly: boolean;
  onSilentOnly: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Search text / metadata…"
        value={searchInput}
        onChange={(e) => onSearchInput(e.target.value)}
        className="h-8 w-64 text-xs"
      />
      <div className="flex flex-wrap items-center gap-1">
        {STATUSES.map((s) => {
          const on = statuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => onToggleStatus(s)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                on
                  ? statusButtonClasses(s, true)
                  : "border-transparent bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {s}
            </button>
          );
        })}
      </div>
      <select
        value={plugin}
        onChange={(e) => onPluginChange(e.target.value)}
        className="h-8 rounded-md border bg-background px-2 text-xs"
      >
        <option value="">all plugins</option>
        {pluginOptions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent">
        <input
          type="checkbox"
          className="size-3 accent-primary"
          checked={silentOnly}
          onChange={(e) => onSilentOnly(e.target.checked)}
        />
        Silent only
      </label>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-3 py-2 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function SortableTh({
  col,
  sortBy,
  sortDir,
  onSort,
  children,
}: {
  col: SortBy;
  sortBy: SortBy;
  sortDir: SortDir;
  onSort: (c: SortBy) => void;
  children: React.ReactNode;
}) {
  const active = sortBy === col;
  return (
    <th className="whitespace-nowrap px-3 py-2 text-[11px] font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {children}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-50" />
        )}
      </button>
    </th>
  );
}

function Row({ agentId, row }: { agentId: string; row: EventRow }) {
  const qc = useQueryClient();
  const requeue = useMutation({
    mutationFn: () => endpoints.requeueEvent(agentId, row.id),
    onSuccess: () => {
      toast.success("requeued");
      qc.invalidateQueries({ queryKey: ["events", agentId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const discard = useMutation({
    mutationFn: () => endpoints.discardEvent(agentId, row.id),
    onSuccess: () => {
      toast.success("discarded");
      qc.invalidateQueries({ queryKey: ["events", agentId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const metaStr = row.metadata ? JSON.stringify(row.metadata) : "";

  return (
    <tr className="border-b last:border-b-0 hover:bg-accent/50">
      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {row.id}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-[11px] text-muted-foreground">
        {formatTime(row.ts)}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-[11px] text-muted-foreground">
        {formatTime(row.updatedAt)}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5">
        <StatusBadge status={row.status} />
        {row.attempts > 0 && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            ·{row.attempts}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">
        {row.pluginId}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {row.channelId}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {row.threadId}
      </td>
      <td className="px-3 py-1.5 text-center text-muted-foreground">
        {row.isSilent ? "•" : ""}
      </td>
      <td className="max-w-[24ch] truncate px-3 py-1.5" title={row.text}>
        {row.text}
      </td>
      <td
        className="max-w-[24ch] truncate px-3 py-1.5 font-mono text-[10px] text-muted-foreground"
        title={metaStr}
      >
        {metaStr}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right">
        {row.status === "failed" && (
          <div className="inline-flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => requeue.mutate()}
              disabled={requeue.isPending}
              title="Requeue"
            >
              <RefreshCcw className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-destructive"
              onClick={() => discard.mutate()}
              disabled={discard.isPending}
              title="Discard"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: EventStatus }) {
  const variant = statusVariant(status);
  return <Badge variant={variant}>{status}</Badge>;
}

function statusVariant(
  s: EventStatus,
): "secondary" | "warning" | "success" | "destructive" | "outline" {
  switch (s) {
    case "queued":
      return "secondary";
    case "in_flight":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "destructive";
    case "cancelled":
      return "outline";
  }
}

function statusButtonClasses(s: EventStatus, on: boolean): string {
  if (!on) return "";
  switch (s) {
    case "queued":
      return "border-transparent bg-secondary text-secondary-foreground";
    case "in_flight":
      return "border-transparent bg-warning/15 text-warning";
    case "done":
      return "border-transparent bg-success/15 text-success";
    case "failed":
      return "border-transparent bg-destructive/15 text-destructive";
    case "cancelled":
      return "border-border bg-background text-foreground";
  }
}

function RangeFilters({
  tsFrom,
  tsTo,
  updatedFrom,
  updatedTo,
  onTsFrom,
  onTsTo,
  onUpdatedFrom,
  onUpdatedTo,
  anyRangeSet,
  onClear,
}: {
  tsFrom: string;
  tsTo: string;
  updatedFrom: string;
  updatedTo: string;
  onTsFrom: (s: string) => void;
  onTsTo: (s: string) => void;
  onUpdatedFrom: (s: string) => void;
  onUpdatedTo: (s: string) => void;
  anyRangeSet: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <RangeGroup
        label="Created"
        from={tsFrom}
        to={tsTo}
        onFrom={onTsFrom}
        onTo={onTsTo}
      />
      <RangeGroup
        label="Updated"
        from={updatedFrom}
        to={updatedTo}
        onFrom={onUpdatedFrom}
        onTo={onUpdatedTo}
      />
      {anyRangeSet && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={onClear}
        >
          <X className="size-3" /> Clear
        </Button>
      )}
    </div>
  );
}

function RangeGroup({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (s: string) => void;
  onTo: (s: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider">{label}</span>
      <input
        type="datetime-local"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        className="h-7 rounded-md border bg-background px-1.5 text-[11px] text-foreground"
      />
      <span>→</span>
      <input
        type="datetime-local"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        className="h-7 rounded-md border bg-background px-1.5 text-[11px] text-foreground"
      />
    </div>
  );
}

function localToMs(local: string): number | undefined {
  if (!local) return undefined;
  const ms = new Date(local).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function Pager({
  total,
  offset,
  pageSize,
  onChange,
}: {
  total: number;
  offset: number;
  pageSize: number;
  onChange: (n: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  const canPrev = offset > 0;
  const canNext = offset + pageSize < total;
  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
      <span>
        {total === 0 ? "no events" : `${from}–${to} of ${total}`}
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          Prev
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={!canNext}
          onClick={() => onChange(offset + pageSize)}
        >
          Next
        </Button>
        {offset > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => onChange(0)}
            title="Back to top"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
