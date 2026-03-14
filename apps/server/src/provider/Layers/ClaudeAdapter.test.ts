import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { afterEach, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);

async function flushEvents() {
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = ["ignore", this.stdout, this.stderr] as const;

  kill(): boolean {
    this.emit("close", 0, null);
    return true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
const fakeChildren: FakeChildProcess[] = [];

const adapterTestLayer = it.layer(
  makeClaudeAdapterLive({
    spawnProcess: ((command, args, options) => {
      const child = new FakeChildProcess();
      spawnCalls.push({
        command,
        args: [...(args ?? [])],
        options: (options ?? {}) as Record<string, unknown>,
      });
      fakeChildren.push(child);
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as typeof import("node:child_process").spawn,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

afterEach(() => {
  for (const child of fakeChildren.splice(0)) {
    child.removeAllListeners();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  spawnCalls.length = 0;
});

adapterTestLayer("ClaudeAdapterLive", (it) => {
  it.effect("uses --session-id for the first turn of a fresh session", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-fresh"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-fresh"),
        input: "hello",
        attachments: [],
      });

      const call = spawnCalls.at(-1);
      assert.ok(call);
      assert.equal(call.command, "claude");
      assert.ok(call.args.includes("--session-id"));
      assert.equal(call.args.includes("--resume"), false);
    }),
  );

  it.effect("uses --resume for a persisted Claude resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-resume"),
        runtimeMode: "full-access",
        resumeCursor: {
          sessionId: "sess-123",
          assistantMessageId: "msg-456",
        },
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-resume"),
        input: "hello again",
        attachments: [],
      });

      const call = spawnCalls.at(-1);
      assert.ok(call);
      assert.ok(call.args.includes("--resume"));
      assert.equal(call.args.includes("--session-id"), false);
      assert.equal(call.args.includes("--resume-session-at"), false);
      const resumeIndex = call.args.indexOf("--resume");
      assert.equal(call.args[resumeIndex + 1], "sess-123");
    }),
  );

  it.effect("uses plain --resume for follow-up turns after the first Claude response", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-follow-up"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-follow-up"),
        input: "hello",
        attachments: [],
      });

      const firstChild = fakeChildren.at(-1);
      assert.ok(firstChild);
      firstChild.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-live" })}\n`,
      );
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-1" },
          },
        })}\n`,
      );
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
        })}\n`,
      );
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          },
        })}\n`,
      );
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_stop",
          },
        })}\n`,
      );
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sess-live",
        })}\n`,
      );
      firstChild.emit("close", 0, null);

      yield* Effect.promise(flushEvents);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-follow-up"),
        input: "hello again",
        attachments: [],
      });

      const secondCall = spawnCalls.at(-1);
      assert.ok(secondCall);
      assert.ok(secondCall.args.includes("--resume"));
      assert.equal(secondCall.args.includes("--session-id"), false);
      assert.equal(secondCall.args.includes("--resume-session-at"), false);
      const resumeIndex = secondCall.args.indexOf("--resume");
      assert.equal(secondCall.args[resumeIndex + 1], "sess-live");
    }),
  );

  it.effect("emits user-input.requested for AskUserQuestion tool calls", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-user-input"),
        runtimeMode: "full-access",
      });

      const userInputEventFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-user-input"),
        input: "ask the user something",
        attachments: [],
      });

      const child = fakeChildren.at(-1);
      assert.ok(child);
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_ask_1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    header: "Scope",
                    question: "Which scope should we target?",
                    options: [
                      {
                        label: "MVP",
                        description: "Ship the smallest working slice first",
                      },
                    ],
                  },
                ],
              },
            },
          },
        })}\n`,
      );

      const maybeUserInputEvent = yield* Fiber.join(userInputEventFiber);
      assert.ok(maybeUserInputEvent._tag === "Some");
      if (maybeUserInputEvent._tag !== "Some") {
        throw new Error("Expected AskUserQuestion to emit user-input.requested.");
      }
      const userInputEvent = maybeUserInputEvent.value;
      if (userInputEvent.type !== "user-input.requested") {
        throw new Error("Expected user-input.requested event.");
      }
      assert.equal(userInputEvent.requestId, "claude:user-input:toolu_ask_1");
      assert.equal(userInputEvent.payload.questions[0]?.id, "0");
      assert.equal(userInputEvent.payload.questions[0]?.header, "Scope");
      assert.equal(userInputEvent.payload.questions[0]?.question, "Which scope should we target?");
      assert.equal(userInputEvent.payload.questions[0]?.options[0]?.label, "MVP");
    }),
  );

  it.effect("emits user-input.requested when AskUserQuestion only appears in permission_denials", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-user-input-permission-denial"),
        runtimeMode: "full-access",
      });

      const userInputEventFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-user-input-permission-denial"),
        input: "ask from permission denial",
        attachments: [],
      });

      const child = fakeChildren.at(-1);
      assert.ok(child);
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-ask-denial" },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Please answer this question." },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_stop",
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sess-ask-denial",
          permission_denials: [
            {
              tool_name: "AskUserQuestion",
              tool_use_id: "toolu_denial_1",
              tool_input: {
                questions: [
                  {
                    header: "Task",
                    question: "What should I retry?",
                    options: [
                      {
                        label: "Review git changes",
                        description: "Inspect the current modified files",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        })}\n`,
      );
      child.emit("close", 0, null);

      const maybeUserInputEvent = yield* Fiber.join(userInputEventFiber);
      assert.ok(maybeUserInputEvent._tag === "Some");
      if (maybeUserInputEvent._tag !== "Some") {
        throw new Error("Expected AskUserQuestion permission denial to emit user-input.requested.");
      }
      const userInputEvent = maybeUserInputEvent.value;
      if (userInputEvent.type !== "user-input.requested") {
        throw new Error("Expected user-input.requested event.");
      }
      assert.equal(userInputEvent.requestId, "claude:user-input:toolu_denial_1");
      assert.equal(userInputEvent.payload.questions[0]?.header, "Task");
      assert.equal(userInputEvent.payload.questions[0]?.question, "What should I retry?");
    }),
  );

  it.effect("includes the original request id when resolving Claude user input", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        provider: "claude",
        threadId: asThreadId("thread-user-input-resolve"),
        runtimeMode: "full-access",
      });

      const resolvedEventFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.resolved"),
      ).pipe(Effect.forkChild);

      yield* adapter.respondToUserInput(
        asThreadId("thread-user-input-resolve"),
        asRequestId("claude:user-input:toolu_resolve_1"),
        {
          answer: "Pizza",
        },
      );

      const maybeResolvedEvent = yield* Fiber.join(resolvedEventFiber);
      assert.ok(maybeResolvedEvent._tag === "Some");
      if (maybeResolvedEvent._tag !== "Some") {
        throw new Error("Expected Claude user-input.resolved event.");
      }
      const resolvedEvent = maybeResolvedEvent.value;
      if (resolvedEvent.type !== "user-input.resolved") {
        throw new Error("Expected user-input.resolved event.");
      }
      assert.equal(resolvedEvent.requestId, "claude:user-input:toolu_resolve_1");
      assert.deepEqual(resolvedEvent.payload.answers, {
        answer: "Pizza",
      });
    }),
  );
});
