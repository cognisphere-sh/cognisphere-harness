import { Cron } from "croner";
import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../core/types.js";

interface Schedule {
  name: string;
  cron: string;
  text: string;
  threadId: string;
  channelId?: string;
  paused?: boolean;
  /** One-shot: after the first fire, the plugin marks the schedule
   *  `paused: true` so it won't fire again. */
  onetime?: boolean;
}

interface SchedulesFile {
  schedules: Schedule[];
}

/**
 * Cron-style scheduler. Watches `<stateDir>/schedules.json` for changes;
 * registers a `croner` timer per active schedule; on fire, emits a
 * `schedule_fire` notification with `threadIdOverride` set to the schedule's
 * stored ThreadId so the reminder lands back where it was set.
 */
export default class SchedulerPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Scheduler",
    description:
      "Cron-style timers. Schedules persisted to state/schedules.json; fires use the harness timezone (see Settings).",
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    secretsSchema: { type: "object", properties: {}, additionalProperties: false },
  };

  private ctx?: PluginInstanceContext;
  private timers = new Map<string, Cron>();
  private statePath = "";
  private fsWatcher: ReturnType<typeof watch> | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    this.statePath = join(ctx.stateDir, "schedules.json");
    if (!existsSync(this.statePath)) {
      writeFileSync(this.statePath, JSON.stringify({ schedules: [] }, null, 2));
    }
    this.reload();
    // Watch the parent dir, not the file: atomic writes (mktemp + rename)
    // replace the inode, and `fs.watch(file)` stays attached to the unlinked
    // inode and never fires again. Watching the dir survives renames.
    this.fsWatcher = watch(ctx.stateDir, { persistent: false }, (_event, fname) => {
      if (fname !== "schedules.json") return;
      if (this.reloadTimer) return;
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        try {
          this.reload();
        } catch (err) {
          ctx.log.error({ err }, "scheduler reload failed");
        }
      }, 50);
    });
    ctx.log.info({ count: this.timers.size }, "scheduler started");
  }

  async stop(): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
    this.ctx = undefined;
  }

  private reload(): void {
    if (!this.ctx) return;
    const tz = this.ctx.timezone;
    const data = JSON.parse(readFileSync(this.statePath, "utf8")) as SchedulesFile;

    for (const t of this.timers.values()) t.stop();
    this.timers.clear();

    for (const s of data.schedules ?? []) {
      if (s.paused) continue;
      try {
        const cron = new Cron(
          s.cron,
          { timezone: tz, name: s.name },
          () => this.fire(s),
        );
        this.timers.set(s.name, cron);
      } catch (err) {
        this.ctx.log.error({ err, name: s.name, cron: s.cron }, "invalid cron");
      }
    }
    this.ctx.log.info({ active: this.timers.size }, "schedules loaded");
  }

  private fire(s: Schedule): void {
    if (!this.ctx) return;
    this.ctx.notify("schedule_fire", {
      text: s.text,
      channelId: s.channelId ?? s.name,
      threadIdOverride: s.threadId,
      doNotSteer: true,
      metadata: { ScheduleName: s.name, Cron: s.cron },
    });
    if (s.onetime) {
      this.timers.get(s.name)?.stop();
      this.timers.delete(s.name);
      this.pauseInFile(s.name);
    }
  }

  /** Read-modify-write `schedules.json` atomically, marking `name` paused.
   *  Triggers our own dir watcher → reload, but reload is idempotent. */
  private pauseInFile(name: string): void {
    if (!this.ctx) return;
    try {
      const data = JSON.parse(readFileSync(this.statePath, "utf8")) as SchedulesFile;
      let changed = false;
      for (const s of data.schedules ?? []) {
        if (s.name === name && !s.paused) {
          s.paused = true;
          changed = true;
        }
      }
      if (!changed) return;
      const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.ctx.log.error({ err, name }, "scheduler one-time pause-after-fire failed");
    }
  }
}
