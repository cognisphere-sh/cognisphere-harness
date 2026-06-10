import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  ChevronDown,
  MessagesSquare,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { endpoints, type EventRow, type EventStatus } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PAGE_SIZE = 100;

// Fixed column widths. Order matches header/body cell order in the table.
// Total drives the table's `min-width`; overflow scrolls horizontally.
const COLS = [
  { key: "select", width: 36 },
  { key: "actions", width: 56 },
  { key: "id", width: 64 },
  { key: "created", width: 130 },
  { key: "updated", width: 130 },
  { key: "status", width: 120 },
  { key: "error", width: 280 },
  { key: "plugin", width: 96 },
  { key: "channel", width: 140 },
  { key: "thread", width: 160 },
  { key: "silent", width: 48 },
  { key: "noSteer", width: 60 },
  { key: "text", width: 280 },
  { key: "metadata", width: 200 },
  { key: "chat", width: 80 },
] as const;
const COL_TOTAL = COLS.reduce((s, c) => s + c.width, 0);

const STATUSES: EventStatus[] = [
  "queued",
  "in_flight",
  "done",
  "failed",
  "cancelled",
];

// Statuses an operator can force a row into. `in_flight` is owned by the
// runner and cannot be set from the UI.
const SETTABLE_STATUSES: EventStatus[] = ["queued", "done", "failed", "cancelled"];

type SilentFilter = "all" | "silent" | "non_silent";

type SortBy = "ts" | "updated_at" | "status" | "plugin_id" | "thread_id";
type SortDir = "asc" | "desc";

interface Props {
  agentId: string;
}

export function EventsTable({ agentId }: Props) {
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<EventStatus[]>([]);
  const [plugin, setPlugin] = useState<string>("");
  const [silent, setSilent] = useState<SilentFilter>("all");
  const [tsFrom, setTsFrom] = useState<string>("");
  const [tsTo, setTsTo] = useState<string>("");
  const [updatedFrom, setUpdatedFrom] = useState<string>("");
  const [updatedTo, setUpdatedTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortBy>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // debounce the search input by 300ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // reset paging + clear selection when filters/sort change
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [
    search,
    statuses,
    plugin,
    silent,
    tsFrom,
    tsTo,
    updatedFrom,
    updatedTo,
    sortBy,
    sortDir,
  ]);

  // also clear selection when paging
  useEffect(() => {
    setSelected(new Set());
  }, [offset]);

  const params = {
    status: statuses.length ? statuses : undefined,
    plugin: plugin || undefined,
    search: search || undefined,
    isSilent:
      silent === "silent" ? true : silent === "non_silent" ? false : undefined,
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

  const rows = useMemo(() => data?.events ?? [], [data]);
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

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["events", agentId] });

  const toggleRow = (id: number, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedOnPage = useMemo(
    () => pageIds.filter((id) => selected.has(id)).length,
    [pageIds, selected],
  );
  const allOnPageSelected =
    pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected;

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  // Rows from the current page that are selected. Bulk actions iterate over
  // these so we always have the row's status/threadId in hand.
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  const selectedInFlight = selectedRows.filter((r) => r.status === "in_flight");
  const selectedNotInFlight = selectedRows.filter(
    (r) => r.status !== "in_flight",
  );

  const bulkSetStatus = useMutation({
    mutationFn: async (status: EventStatus) => {
      const targets = selectedNotInFlight.map((r) => r.id);
      const results = await Promise.allSettled(
        targets.map((id) => endpoints.setEventStatus(agentId, id, status)),
      );
      return {
        total: targets.length,
        ok: results.filter((r) => r.status === "fulfilled").length,
      };
    },
    onSuccess: ({ total, ok }, status) => {
      if (total === 0) toast.message("no eligible rows (in_flight rows skipped)");
      else if (ok === total) toast.success(`status → ${status} (${ok})`);
      else toast.warning(`status → ${status} (${ok}/${total})`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const targets = selectedNotInFlight.map((r) => r.id);
      const results = await Promise.allSettled(
        targets.map((id) => endpoints.discardEvent(agentId, id)),
      );
      return {
        total: targets.length,
        ok: results.filter((r) => r.status === "fulfilled").length,
      };
    },
    onSuccess: ({ total, ok }) => {
      if (total === 0) toast.message("no eligible rows (in_flight rows skipped)");
      else if (ok === total) toast.success(`deleted ${ok}`);
      else toast.warning(`deleted ${ok}/${total}`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const bulkAbort = useMutation({
    mutationFn: async () => {
      const threadIds = [
        ...new Set(selectedInFlight.map((r) => r.threadId)),
      ];
      const results = await Promise.allSettled(
        threadIds.map((tid) => endpoints.abortChat(agentId, tid)),
      );
      return {
        total: threadIds.length,
        ok: results.filter((r) => r.status === "fulfilled").length,
      };
    },
    onSuccess: ({ total, ok }) => {
      if (total === 0) toast.message("no in_flight rows selected");
      else if (ok === total) toast.success(`abort sent to ${ok} thread${ok === 1 ? "" : "s"}`);
      else toast.warning(`abort: ${ok}/${total} threads`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

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
        silent={silent}
        onSilentChange={setSilent}
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

      {selected.size > 0 && (
        <BulkBar
          selectedCount={selected.size}
          inFlightCount={selectedInFlight.length}
          notInFlightCount={selectedNotInFlight.length}
          busy={
            bulkSetStatus.isPending ||
            bulkDelete.isPending ||
            bulkAbort.isPending
          }
          onSetStatus={(s) => bulkSetStatus.mutate(s)}
          onAbort={() => bulkAbort.mutate()}
          onDelete={() => bulkDelete.mutate()}
          onClear={() => setSelected(new Set())}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <table className="w-full table-fixed text-xs" style={{ minWidth: COL_TOTAL }}>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b text-left">
              <Th className="text-center">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={someOnPageSelected}
                  onChange={toggleAllOnPage}
                  disabled={pageIds.length === 0}
                  ariaLabel="Select all rows on this page"
                />
              </Th>
              <Th>Actions</Th>
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
              <Th>Error</Th>
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
              <Th>No-Steer</Th>
              <Th>Text</Th>
              <Th>Metadata</Th>
              <Th>Chat</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.id}
                agentId={agentId}
                row={r}
                selected={selected.has(r.id)}
                onToggleSelect={(on) => toggleRow(r.id, on)}
              />
            ))}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLS.length}
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
  silent,
  onSilentChange,
}: {
  searchInput: string;
  onSearchInput: (s: string) => void;
  statuses: EventStatus[];
  onToggleStatus: (s: EventStatus) => void;
  plugin: string;
  pluginOptions: string[];
  onPluginChange: (p: string) => void;
  silent: SilentFilter;
  onSilentChange: (v: SilentFilter) => void;
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
      <select
        value={silent}
        onChange={(e) => onSilentChange(e.target.value as SilentFilter)}
        className="h-8 rounded-md border bg-background px-2 text-xs"
        title="Silent filter"
      >
        <option value="all">silent: any</option>
        <option value="silent">silent only</option>
        <option value="non_silent">non-silent only</option>
      </select>
    </div>
  );
}

function Checkbox({
  checked,
  indeterminate,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      aria-label={ariaLabel}
    />
  );
}

function BulkBar({
  selectedCount,
  inFlightCount,
  notInFlightCount,
  busy,
  onSetStatus,
  onAbort,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  inFlightCount: number;
  notInFlightCount: number;
  busy: boolean;
  onSetStatus: (s: EventStatus) => void;
  onAbort: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/30 px-3 py-1.5 text-xs">
      <span className="font-medium">
        {selectedCount} selected
        {inFlightCount > 0 && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            ({inFlightCount} in_flight)
          </span>
        )}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={busy || notInFlightCount === 0}
            title={
              notInFlightCount === 0
                ? "No eligible (non-in_flight) rows"
                : "Set status for non-in_flight rows"
            }
          >
            Set status
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[8rem]">
          {SETTABLE_STATUSES.map((s) => (
            <DropdownMenuItem
              key={s}
              onSelect={() => onSetStatus(s)}
              className="text-xs"
            >
              <StatusBadge status={s} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs text-warning hover:text-warning"
        disabled={busy || inFlightCount === 0}
        onClick={onAbort}
        title={
          inFlightCount === 0
            ? "No in_flight rows selected"
            : `Abort ${inFlightCount} in_flight row${inFlightCount === 1 ? "" : "s"} (dedup by thread)`
        }
      >
        <Ban className="size-3" /> Abort
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
        disabled={busy || notInFlightCount === 0}
        onClick={onDelete}
        title={
          notInFlightCount === 0
            ? "No eligible (non-in_flight) rows"
            : `Delete ${notInFlightCount} row${notInFlightCount === 1 ? "" : "s"}`
        }
      >
        <Trash2 className="size-3" /> Delete
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="ml-auto h-7 px-2 text-xs"
        onClick={onClear}
        disabled={busy}
      >
        Clear
      </Button>
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

function Row({
  agentId,
  row,
  selected,
  onToggleSelect,
}: {
  agentId: string;
  row: EventRow;
  selected: boolean;
  onToggleSelect: (on: boolean) => void;
}) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["events", agentId] });
  const setStatus = useMutation({
    mutationFn: (next: EventStatus) =>
      endpoints.setEventStatus(agentId, row.id, next),
    onSuccess: (_d, next) => {
      toast.success(next === "queued" ? "requeued" : `status → ${next}`);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const discard = useMutation({
    mutationFn: () => endpoints.discardEvent(agentId, row.id),
    onSuccess: () => {
      toast.success("deleted");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const abort = useMutation({
    mutationFn: () => endpoints.abortChat(agentId, row.threadId),
    onSuccess: (r) => {
      if (r.ok) toast.info("abort sent");
      else toast.message("nothing in flight");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const metaStr = row.metadata ? JSON.stringify(row.metadata) : "";
  const locked = row.status === "in_flight";

  return (
    <tr className="border-b last:border-b-0 hover:bg-accent/50">
      <td className="whitespace-nowrap px-3 py-1.5 text-center">
        <Checkbox
          checked={selected}
          onChange={(on) => onToggleSelect(on)}
          ariaLabel={`Select row ${row.id}`}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-1.5">
        {locked ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-warning"
            onClick={() => abort.mutate()}
            disabled={abort.isPending}
            title="Abort this batch"
          >
            <Ban className="size-3" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-destructive"
            onClick={() => discard.mutate()}
            disabled={discard.isPending}
            title="Delete row"
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </td>
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
        <StatusControl
          status={row.status}
          disabled={locked || setStatus.isPending}
          onChange={(next) => {
            if (next !== row.status) setStatus.mutate(next);
          }}
        />
        {row.attempts > 0 && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            ·{row.attempts}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <TruncatedCell text={row.error}>
          <ErrorCell error={row.error} />
        </TruncatedCell>
      </td>
      <td className="px-3 py-1.5 font-mono text-[11px]">
        <TruncatedCell text={row.pluginId}>{row.pluginId}</TruncatedCell>
      </td>
      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <TruncatedCell text={row.channelId}>{row.channelId}</TruncatedCell>
      </td>
      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <TruncatedCell text={row.threadId}>{row.threadId}</TruncatedCell>
      </td>
      <td className="px-3 py-1.5 text-center text-muted-foreground">
        {row.isSilent ? "•" : ""}
      </td>
      <td
        className="px-3 py-1.5 text-center text-muted-foreground"
        title={row.doNotSteer ? "doNotSteer: never steered into a live batch" : undefined}
      >
        {row.doNotSteer ? "•" : ""}
      </td>
      <td className="px-3 py-1.5">
        <TruncatedCell text={row.text}>{row.text}</TruncatedCell>
      </td>
      <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <TruncatedCell text={metaStr}>{metaStr}</TruncatedCell>
      </td>
      <td className="whitespace-nowrap px-3 py-1.5">
        {row.piSessionId && row.piEntryId ? (
          <Link
            to={`/agents/${agentId}/chat?thread=${encodeURIComponent(row.threadId)}&session=${encodeURIComponent(row.piSessionId)}&entry=${encodeURIComponent(row.piEntryId)}`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
            title={`Open in chat\nsession ${row.piSessionId}\nentry ${row.piEntryId}`}
          >
            <MessagesSquare className="size-3" />
            open
          </Link>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: EventStatus }) {
  const variant = statusVariant(status);
  return <Badge variant={variant}>{status}</Badge>;
}

/** Render `error` with its leading `[reason]` tag (runner convention) as a
 *  small badge, and the remainder of the message truncated next to it.
 *  Full text is shown in the cell's wrapping <TruncatedCell> tooltip. */
function ErrorCell({ error }: { error: string | null }) {
  if (!error) return <span className="text-[10px] text-muted-foreground">—</span>;
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(error);
  const reason = m ? m[1] : null;
  const rest = m ? m[2] : error;
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {reason && (
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {reason}
        </Badge>
      )}
      <span className="truncate text-[11px] text-muted-foreground">{rest}</span>
    </div>
  );
}

/**
 * Wraps a truncated cell with a radix tooltip that shows the full text on
 * hover. `title` no longer needed on the <td>. Empty/null `text` renders
 * children plainly without a tooltip.
 */
function TruncatedCell({
  text,
  className,
  children,
}: {
  text: string | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  if (!text) return <div className={cn("truncate", className)}>{children}</div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("truncate", className)}>{children}</div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-[60ch] whitespace-pre-wrap break-words"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function StatusControl({
  status,
  disabled,
  onChange,
}: {
  status: EventStatus;
  disabled: boolean;
  onChange: (next: EventStatus) => void;
}) {
  if (disabled) {
    return <StatusBadge status={status} />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Change status"
        >
          <StatusBadge status={status} />
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[8rem]">
        {SETTABLE_STATUSES.map((s) => (
          <DropdownMenuItem
            key={s}
            disabled={s === status}
            onSelect={() => onChange(s)}
            className="text-xs"
          >
            <StatusBadge status={s} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
