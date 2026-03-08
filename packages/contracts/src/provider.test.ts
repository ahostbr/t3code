import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts claude-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-claude",
      provider: "claude",
      cwd: "/tmp/workspace",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claude: {
          effort: "high",
        },
      },
      runtimeMode: "approval-required",
      providerOptions: {
        claude: {
          binaryPath: "/usr/local/bin/claude",
          homePath: "/tmp/.claude",
        },
      },
    });

    expect(parsed.provider).toBe("claude");
    expect(parsed.modelOptions?.claude?.effort).toBe("high");
    expect(parsed.providerOptions?.claude?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claude?.homePath).toBe("/tmp/.claude");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });

  it("accepts claude-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-claude",
      model: "claude-opus-4-6",
      modelOptions: {
        claude: {
          effort: "medium",
        },
      },
    });

    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.modelOptions?.claude?.effort).toBe("medium");
  });
});
