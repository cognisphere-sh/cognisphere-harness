/**
 * Message router — the only thing that decides which thread a message goes to.
 * Every event from every plugin (Telegram, Gmail, scheduler, agent-messaging,
 * the console, …) passes through `route` before it is queued. Return:
 *
 *   - `"<threadId>"`        one thread
 *   - `["a", "b"]`          several threads (one queued copy each)
 *   - `"workflow:<name>"`   a workflow thread: the script in
 *                           `workspace/workflows/<name>/` runs once per message
 *   - `[]`                  drop the message
 *   - `undefined`           `msg.metadata.threadId` if set, else `"main"`
 *
 * Plugins that target a thread (agent-messaging, the scheduler, the console)
 * set `metadata.threadId`; the others (Telegram, Gmail) leave it to you, so
 * write rules for them here. Keep it synchronous and fast: it runs inside the
 * harness for every message. Edits apply within a few seconds; an edit that
 * fails to load keeps the previous router, and a router that throws or returns
 * an unsafe or unknown id sends the message to the default above.
 */

export interface RouterMessage {
  /** Event name, e.g. `message_received`, `email_received`, `schedule_fire`, `agent_message`. */
  notification: string;
  pluginId: string;
  /** The source conversation: Telegram chat id, Gmail thread id, … */
  channelId: string;
  text: string;
  metadata: Record<string, unknown>;
  isSilent: boolean;
}

export interface WorkflowInfo {
  name: string;
  description: string;
}

export default function route(
  msg: RouterMessage,
  workflows: WorkflowInfo[],
): string | string[] | undefined {
  void workflows;
  // Rules go here, for example:
  //   if (msg.pluginId === "telegram") return `telegram:${msg.channelId}`;   // one thread per chat
  //   if (msg.pluginId === "gws" && /invoice/i.test(String(msg.metadata.Subject))) return "workflow:invoices";
  const threadId = msg.metadata.threadId;
  return typeof threadId === "string" && threadId ? threadId : "main";
}
