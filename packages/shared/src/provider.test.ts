import { describe, expect, it } from "vitest";

import { isProviderKind, normalizeProviderKind, resolveProviderKind } from "./provider";

describe("provider helpers", () => {
  it("normalizes canonical provider ids", () => {
    expect(normalizeProviderKind("codex")).toBe("codex");
    expect(normalizeProviderKind("claude")).toBe("claude");
  });

  it("normalizes legacy Claude provider ids", () => {
    expect(normalizeProviderKind("claudeCode")).toBe("claude");
  });

  it("rejects unknown provider ids", () => {
    expect(normalizeProviderKind("cursor")).toBeNull();
    expect(normalizeProviderKind(undefined)).toBeNull();
  });

  it("resolves a fallback provider", () => {
    expect(resolveProviderKind("claudeCode")).toBe("claude");
    expect(resolveProviderKind("unknown")).toBe("codex");
    expect(resolveProviderKind("unknown", "claude")).toBe("claude");
  });

  it("checks provider kinds", () => {
    expect(isProviderKind("codex")).toBe(true);
    expect(isProviderKind("claudeCode")).toBe(true);
    expect(isProviderKind("cursor")).toBe(false);
  });
});
