import { Cron } from "croner";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../src/types.js";

interface Schedule {
  name: string;
  cron: string;
  text: string;
  threadId: string;
  channelId?: string;
  paused?: boolean;
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
    description: "Cron-style timers. Schedules persisted to state/schedules.json.",
    notifications: [
      {
        name: "schedule_fire",
        description: "A scheduled time arrived; the agent should act on it.",
      },
    ],
    configSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA tz; default UTC" },
      },
      additionalProperties: false,
    },
    secretsSchema: { type: "object", properties: {}, additionalProperties: false },
  };

  private ctx?: PluginInstanceContext;
  private timers = new Map<string, Cron>();
  private statePath = "";
  private fsWatcher: ReturnType<typeof watch> | null = null;

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    this.statePath = join(ctx.stateDir, "schedules.json");
    if (!existsSync(this.statePath)) {
      writeFileSync(this.statePath, JSON.stringify({ schedules: [] }, null, 2));
    }
    this.reload();
    this.fsWatcher = watch(this.statePath, { persistent: false }, () => {
      try {
        this.reload();
      } catch (err) {
        ctx.log.error({ err }, "scheduler reload failed");
      }
    });
    ctx.log.info({ count: this.timers.size }, "scheduler started");
  }

  async stop(): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
    this.ctx = undefined;
  }

  private reload(): void {
    if (!this.ctx) return;
    const cfg = (this.ctx.config as { timezone?: string } | undefined) ?? {};
    const tz = cfg.timezone ?? "UTC";
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
  }
}
