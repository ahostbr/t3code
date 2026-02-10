import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatStartupError, parseCliOptions, readCliVersion } from "./cli";

describe("parseCliOptions", () => {
  it("reads defaults from environment variables", () => {
    const options = parseCliOptions(
      [],
      {
        T3_BACKEND_PORT: "5001",
        T3_WEB_PORT: "5002",
        T3_NO_OPEN: "1",
      },
      "/workspace",
    );

    expect(options.backendPort).toBe(5001);
    expect(options.webPort).toBe(5002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe("/workspace");
    expect(options.backendPortLocked).toBe(true);
    expect(options.webPortLocked).toBe(true);
  });

  it("accepts flexible truthy values for T3_NO_OPEN", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("parses case-insensitive and trimmed T3_NO_OPEN truthy values", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "  YeS ",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("accepts 'on' as T3_NO_OPEN truthy value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "on",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("accepts 'yes' as T3_NO_OPEN truthy value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "yes",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("treats non-truthy T3_NO_OPEN values as disabled", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "0",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("treats unknown T3_NO_OPEN values as disabled", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "definitely-not-boolean",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("allows command line arguments to override defaults", () => {
    const options = parseCliOptions(
      [
        "--backend-port",
        "7001",
        "--web-port=7002",
        "--cwd",
        "apps/t3",
        "--no-open",
      ],
      {},
      "/workspace",
    );

    expect(options.backendPort).toBe(7001);
    expect(options.webPort).toBe(7002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/t3"));
    expect(options.backendPortLocked).toBe(true);
    expect(options.webPortLocked).toBe(true);
  });

  it("accepts a positional cwd argument", () => {
    const options = parseCliOptions(["apps/renderer"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("trims positional cwd arguments before resolving path", () => {
    const options = parseCliOptions(["  apps/renderer  "], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("resolves relative cwd arguments against provided parser cwd", () => {
    const options = parseCliOptions(["--cwd", "project"], {}, "/tmp/t3-root");
    expect(options.launchCwd).toBe(path.resolve("/tmp/t3-root", "project"));
  });

  it("rejects whitespace-only positional cwd arguments", () => {
    expect(() => parseCliOptions(["   "], {}, "/workspace")).toThrow("Invalid value for [path]");
  });

  it("rejects multiple positional cwd arguments", () => {
    expect(() => parseCliOptions(["apps/renderer", "apps/t3"], {}, "/workspace")).toThrow(
      "Unexpected positional argument: apps/t3",
    );
  });

  it("keeps ports unlocked when using defaults", () => {
    const options = parseCliOptions([], {}, "/workspace");
    expect(options.backendPortLocked).toBe(false);
    expect(options.webPortLocked).toBe(false);
  });

  it("supports help flag", () => {
    const options = parseCliOptions(["--help"], {}, "/workspace");
    expect(options.showHelp).toBe(true);
  });

  it("supports short help flag alias", () => {
    const options = parseCliOptions(["-h"], {}, "/workspace");
    expect(options.showHelp).toBe(true);
  });

  it("supports version flag", () => {
    const options = parseCliOptions(["--version"], {}, "/workspace");
    expect(options.showVersion).toBe(true);
  });

  it("supports short version flag alias", () => {
    const options = parseCliOptions(["-v"], {}, "/workspace");
    expect(options.showVersion).toBe(true);
  });

  it("throws for invalid explicit port values", () => {
    expect(() => parseCliOptions(["--web-port", "nope"], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("throws for empty equals-style backend port values", () => {
    expect(() => parseCliOptions(["--backend-port="], {}, "/workspace")).toThrow(
      "Invalid value for --backend-port",
    );
  });

  it("throws for empty equals-style web port values", () => {
    expect(() => parseCliOptions(["--web-port="], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("throws when backend port value is missing", () => {
    expect(() => parseCliOptions(["--backend-port"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("throws when web port value is missing", () => {
    expect(() => parseCliOptions(["--web-port"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("throws for invalid environment port values", () => {
    expect(() => parseCliOptions([], { T3_WEB_PORT: "nope" }, "/workspace")).toThrow(
      "Invalid value for T3_WEB_PORT",
    );
  });

  it("throws for invalid backend environment port values", () => {
    expect(() => parseCliOptions([], { T3_BACKEND_PORT: "nope" }, "/workspace")).toThrow(
      "Invalid value for T3_BACKEND_PORT",
    );
  });

  it("throws for empty cwd flag values", () => {
    expect(() => parseCliOptions(["--cwd="], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("throws for whitespace-only equals-style cwd values", () => {
    expect(() => parseCliOptions(["--cwd=   "], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("throws when cwd flag value is missing", () => {
    expect(() => parseCliOptions(["--cwd"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("throws for whitespace-only cwd flag values", () => {
    expect(() => parseCliOptions(["--cwd", "   "], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("trims cwd flag values before resolving path", () => {
    const options = parseCliOptions(["--cwd", "  apps/renderer  "], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("throws for unknown arguments", () => {
    expect(() => parseCliOptions(["--wat"], {}, "/workspace")).toThrow(
      "Unknown argument: --wat",
    );
  });
});

describe("readCliVersion", () => {
  it("prefers npm_package_version from environment", () => {
    const value = readCliVersion("/tmp/does-not-matter.json", {
      npm_package_version: "9.9.9",
    });
    expect(value).toBe("9.9.9");
  });

  it("falls back to package json version when env is missing", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-version-test-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ version: "1.2.3" }), "utf8");
    const value = readCliVersion(packageJsonPath, {});
    expect(value).toBe("1.2.3");
  });

  it("returns default when env and package file are unavailable", () => {
    const value = readCliVersion("/tmp/no-such-package.json", {});
    expect(value).toBe("0.1.0");
  });
});

describe("formatStartupError", () => {
  const options = parseCliOptions([], {}, "/workspace");

  it("returns helpful guidance for port conflicts", () => {
    const message = formatStartupError({ code: "EADDRINUSE" }, options);
    expect(message).toContain("Port already in use");
    expect(message).toContain("--backend-port");
  });

  it("returns error message when available", () => {
    const message = formatStartupError(new Error("boom"), options);
    expect(message).toBe("boom");
  });

  it("falls back to generic startup error text", () => {
    const message = formatStartupError({}, options);
    expect(message).toBe("Failed to start t3 runtime.");
  });
});
