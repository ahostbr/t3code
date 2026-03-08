import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

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
      const resumeIndex = call.args.indexOf("--resume");
      assert.equal(call.args[resumeIndex + 1], "sess-123");
      const resumeAtIndex = call.args.indexOf("--resume-session-at");
      assert.equal(call.args[resumeAtIndex + 1], "msg-456");
    }),
  );
});
