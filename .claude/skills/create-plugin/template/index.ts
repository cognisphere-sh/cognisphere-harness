/**
 * hello — minimal example plugin: ticks on an interval and notifies the agent.
 */

interface HelloConfig {
  intervalSec?: number;
}

// Duck-typed against the harness's Plugin interface (core/types.ts) — user
// plugins don't import from the harness package.
export default class HelloPlugin {
  manifest = {
    displayName: "Hello",
    description: "Example plugin: periodic hello notifications",
    configSchema: {
      type: "object",
      properties: {
        intervalSec: { type: "number", default: 300 },
      },
      additionalProperties: false,
    },
    secretsSchema: { type: "object", properties: {}, required: [] },
  };

  private timer: ReturnType<typeof setInterval> | null = null;

  async start(ctx: {
    agentId: string;
    config: unknown;
    notify: (name: string, payload: Record<string, unknown>) => void;
    log: { info: (obj: unknown, msg?: string) => void };
  }): Promise<void> {
    const cfg = ctx.config as HelloConfig;
    ctx.log.info({ intervalSec: cfg.intervalSec }, "hello plugin started");
    this.timer = setInterval(() => {
      ctx.notify("hello_tick", {
        text: `Hello from the hello plugin on ${ctx.agentId}.`,
        channelId: "hello",
      });
    }, (cfg.intervalSec ?? 300) * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
