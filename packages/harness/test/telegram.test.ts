/**
 * Telegram plugin against a fake Bot API: topic metadata, and questions built
 * by the real `telegram-cli` and answered by the plugin in-process.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import type { NotifyPayload, Plugin } from "../src/core/types.js";

const run = promisify(execFile);
const CLI = fileURLToPath(
  new URL("../src/plugins/telegram/seed/scripts/telegram/telegram-cli", import.meta.url),
);
const log = pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" });

type Body = Record<string, unknown>;
type Button = { text: string; callback_data?: string };
interface Call {
  method: string;
  body: Body;
}

/** A Bot API that records every call and hands out queued updates. */
class FakeBotApi {
  calls: Call[] = [];
  private updates: unknown[] = [];
  private answeredTaps = new Set<string>();
  private nextUpdate = 1;
  private nextMessage = 100;
  server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const method = (req.url ?? "").split("/").pop()!;
        const body = (raw ? JSON.parse(raw) : {}) as Body;
        const reply = (result: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (method === "getUpdates") {
          // Long-poll briefly so the plugin's loop doesn't spin.
          setTimeout(() => reply(this.updates.splice(0)), this.updates.length ? 0 : 30);
          return;
        }
        this.calls.push({ method, body });
        if (method === "getMe") return reply({ id: 999, username: "TestBot" });
        if (method === "answerCallbackQuery") {
          // Telegram accepts one answer per tap.
          const id = String(body.callback_query_id);
          if (this.answeredTaps.has(id)) {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ ok: false, description: "Bad Request: query is too old" }));
          }
          this.answeredTaps.add(id);
        }
        if (method === "sendMessage") {
          return reply({ message_id: this.nextMessage++, chat: { id: body.chat_id }, date: 1 });
        }
        reply(true);
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  push(update: Body): void {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
  }

  callsTo(method: string): Body[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.body);
  }
}

const api = new FakeBotApi();
let TelegramPlugin: new () => Plugin;

before(async () => {
  await api.listen();
  // The plugin reads the API URL at import time.
  process.env.TELEGRAM_API_URL = api.url;
  TelegramPlugin = (await import("../src/plugins/telegram/index.js")).default;
});
after(() => api.server.close());

interface Started {
  events: Array<{ name: string } & NotifyPayload>;
  stop(): Promise<void>;
}

async function startPlugin(config: Record<string, unknown> = {}): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
  for (const d of ["state", "inbox"]) mkdirSync(join(dir, d));
  const events: Started["events"] = [];
  const plugin = new TelegramPlugin();
  await plugin.start({
    agentId: "a",
    agentDir: dir,
    stateDir: join(dir, "state"),
    inboxDir: join(dir, "inbox"),
    config,
    secrets: { TELEGRAM_BOT_TOKEN: "t" },
    timezone: "UTC",
    notify: (name, payload) => events.push({ name, ...payload }),
    log,
  });
  return {
    events,
    async stop() {
      await plugin.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Run telegram-cli against the fake API; returns its parsed stdout. */
async function cli(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, [CLI, ...args], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_API_URL: api.url },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

const CHAT = { id: -1001, type: "supergroup", title: "Warehouse" };
const alice = { id: 5, first_name: "Alice" };
const bob = { id: 6, first_name: "Bob" };

/** The message a callback carries: what the CLI just sent, as Telegram
 *  would echo it back. */
function sentMessage(body: Body, messageId: number): Body {
  return {
    message_id: messageId,
    chat: CHAT,
    date: 1,
    text: "Pick one",
    reply_markup: body.reply_markup,
    ...(body.message_thread_id ? { message_thread_id: body.message_thread_id, is_topic_message: true } : {}),
  };
}

function buttons(body: Body): Button[] {
  return (body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
}

let tap = 0;
function pushTap(message: Body, data: string | undefined, from = alice): void {
  api.push({ callback_query: { id: `q${++tap}`, from, message, data } });
}

test("topic messages carry TopicId and TopicName; the topic root isn't a reply", async () => {
  const p = await startPlugin();
  try {
    api.push({
      message: {
        message_id: 7,
        message_thread_id: 7,
        is_topic_message: true,
        chat: CHAT,
        date: 1,
        from: alice,
        forum_topic_created: { name: "Orders" },
      },
    });
    api.push({
      message: {
        message_id: 8,
        message_thread_id: 7,
        is_topic_message: true,
        chat: CHAT,
        date: 1,
        from: alice,
        text: "hi @testbot",
        reply_to_message: { message_id: 7, chat: CHAT, date: 1, forum_topic_created: { name: "Orders" } },
      },
    });
    // A reply chain in a plain supergroup also has message_thread_id.
    api.push({
      message: { message_id: 9, message_thread_id: 3, chat: CHAT, date: 1, from: bob, text: "plain" },
    });
    await until(() => p.events.length === 3, "three events");
    const [created, msg, plain] = p.events;
    assert.equal(created!.name, "topic_event");
    assert.equal(created!.metadata?.TopicEvent, "created");
    assert.equal(created!.metadata?.TopicId, 7);
    assert.equal(msg!.name, "message_received");
    assert.equal(msg!.channelId, String(CHAT.id));
    assert.equal(msg!.metadata?.TopicId, 7);
    assert.equal(msg!.metadata?.TopicName, "Orders");
    assert.equal(msg!.metadata?.ChatType, "supergroup");
    assert.equal(msg!.metadata?.ReplyToMessageId, undefined);
    assert.equal(msg!.metadata?.MentionsBot, true);
    assert.equal(plain!.metadata?.TopicId, undefined);
  } finally {
    await p.stop();
  }
});

test("single-choice ask: one tap answers, edits the question and emits once", async () => {
  const p = await startPlugin();
  try {
    const sent = await cli(
      "ask", "--chat-id", String(CHAT.id), "--text", "Pick one",
      "--option", "Yes", "--option", "No", "--topic-id", "7", "--tag", "restock:A1",
    );
    const body = api.callsTo("sendMessage").at(-1)!;
    assert.equal(body.message_thread_id, 7);
    const msg = sentMessage(body, sent.message_id as number);
    pushTap(msg, buttons(body)[1]!.callback_data);
    await until(() => p.events.length === 1, "the answer");
    const e = p.events[0]!;
    assert.equal(e.name, "question_answered");
    assert.deepEqual(e.metadata?.Answers, ["No"]);
    assert.deepEqual(e.metadata?.AnswerIndexes, [1]);
    assert.equal(e.metadata?.TopicId, 7);
    assert.equal(e.metadata?.SenderId, alice.id);
    assert.equal(e.metadata?.QuestionTag, "restock:A1");
    const edit = api.callsTo("editMessageText").at(-1)!;
    assert.match(String(edit.text), /^Pick one\n\n✅ Alice: No$/);
    assert.deepEqual(edit.reply_markup, { inline_keyboard: [] });

    // A second tap on the stale keyboard is answered but not emitted.
    pushTap(msg, buttons(body)[0]!.callback_data, bob);
    await until(() => api.callsTo("answerCallbackQuery").some((a) => a.text === "Already answered."), "toast");
    assert.equal(p.events.length, 1);
  } finally {
    await p.stop();
  }
});

test("multi-choice ask: toggles edit the keyboard, Done emits the picks", async () => {
  const p = await startPlugin();
  try {
    const sent = await cli(
      "ask", "--chat-id", String(CHAT.id), "--text", "Pick one", "--multi",
      "--option", "A", "--option", "B", "--option", "C", "--only-user", String(alice.id),
    );
    const body = api.callsTo("sendMessage").at(-1)!;
    const msg = sentMessage(body, sent.message_id as number);
    const [a, , c, done] = buttons(body);
    assert.equal(done!.text, "Done");

    pushTap(msg, a!.callback_data, bob);
    await until(() => api.callsTo("answerCallbackQuery").some((x) => x.show_alert === true), "alert");

    const edits = api.callsTo("editMessageReplyMarkup").length;
    pushTap(msg, a!.callback_data);
    pushTap(msg, c!.callback_data); // the stale snapshot doesn't lose A
    await until(() => api.callsTo("editMessageReplyMarkup").length === edits + 2, "toggle edits");
    const kb = (api.callsTo("editMessageReplyMarkup").at(-1)!.reply_markup as {
      inline_keyboard: Button[][];
    }).inline_keyboard.flat();
    assert.deepEqual(kb.map((b) => b.text), ["✅ A", "B", "✅ C", "Done"]);
    assert.equal(p.events.length, 0);

    pushTap(msg, done!.callback_data);
    await until(() => p.events.length === 1, "the answer");
    assert.deepEqual(p.events[0]!.metadata?.Answers, ["A", "C"]);
    assert.deepEqual(p.events[0]!.metadata?.AnswerIndexes, [0, 2]);
  } finally {
    await p.stop();
  }
});

test("custom buttons emit button_pressed; taps from chats outside allowedChatIds are dropped", async () => {
  const p = await startPlugin({ allowedChatIds: [String(CHAT.id)] });
  try {
    const sent = await cli(
      "send-message", "--chat-id", String(CHAT.id), "--text", "Board",
      "--buttons", '[[{"text":"📷 A1","data":"pick:A1"},{"text":"Docs","url":"https://example.com"}]]',
    );
    const body = api.callsTo("sendMessage").at(-1)!;
    const msg = { ...sentMessage(body, sent.message_id as number), text: "Board" };
    pushTap({ ...msg, chat: { id: 42, type: "private" } }, "pick:A1");
    pushTap(msg, "pick:A1");
    await until(() => p.events.length === 1, "the press");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.events.length, 1);
    const e = p.events[0]!;
    assert.equal(e.name, "button_pressed");
    assert.equal(e.metadata?.CallbackData, "pick:A1");
    assert.equal(e.metadata?.ButtonText, "📷 A1");
    assert.equal(e.metadata?.MessageText, "Board");
  } finally {
    await p.stop();
  }
});

test("a wait button's tap is held for answer-tap, else answered silently after tapWaitMs", async () => {
  const p = await startPlugin({ tapWaitMs: 150 });
  try {
    const sent = await cli(
      "send-message", "--chat-id", String(CHAT.id), "--text", "Board",
      "--buttons", '[[{"text":"Submit","data":"submit:A1","wait":true},{"text":"Now","data":"now"}]]',
    );
    const body = api.callsTo("sendMessage").at(-1)!;
    const [submit, now] = buttons(body);
    assert.equal(submit!.callback_data, "wait:submit:A1");
    const msg = sentMessage(body, sent.message_id as number);
    const answersTo = (id: string) => api.callsTo("answerCallbackQuery").filter((a) => a.callback_query_id === id);

    pushTap(msg, submit!.callback_data);
    pushTap(msg, now!.callback_data);
    await until(() => p.events.length === 2, "two presses");
    const [held, plain] = p.events;
    assert.equal(held!.metadata?.CallbackData, "submit:A1");
    const qid = String(held!.metadata?.CallbackQueryId);
    assert.equal(plain!.metadata?.CallbackQueryId, undefined);
    assert.equal(answersTo(`q${tap}`).length, 1, "plain tap answered at once");
    assert.equal(answersTo(qid).length, 0, "held tap not answered yet");

    // What a workflow does:
    const answerTap = async (id: string) =>
      (await run(process.execPath, [CLI, "answer-tap", "--id", id, "--text", "Submitted, thanks!"], {
        env: { ...process.env, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_API_URL: api.url },
      })).stdout.trim();
    assert.equal(await answerTap(qid), "ok");
    assert.equal(answersTo(qid)[0]!.text, "Submitted, thanks!");
    // The plugin's silent fallback still fires (Telegram rejects it harmlessly).
    await until(() => answersTo(qid).length === 2, "fallback answer");
    assert.equal(answersTo(qid)[1]!.text, undefined);

    // A workflow slower than tapWaitMs: answer-tap is late but exits 0.
    pushTap(msg, submit!.callback_data);
    await until(() => p.events.length === 3, "third press");
    const slow = String(p.events[2]!.metadata?.CallbackQueryId);
    await until(() => answersTo(slow).length === 1, "silent fallback");
    assert.equal(await answerTap(slow), "late");
  } finally {
    await p.stop();
  }
});

test("telegram-cli rejects reserved and oversized button data", async () => {
  for (const data of ["ask:s:0", "wait:x", "x".repeat(65)]) {
    await assert.rejects(
      run(process.execPath, [CLI, "send-message", "--chat-id", "1", "--text", "t",
        "--buttons", JSON.stringify([{ text: "b", data }])], {
        env: { ...process.env, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_API_URL: api.url },
      }),
    );
  }
});
