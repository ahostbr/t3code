import { type ProviderKind } from "@t3tools/contracts";

const LEGACY_PROVIDER_ALIASES = {
  claudeCode: "claude",
} as const satisfies Record<string, ProviderKind>;

export function normalizeProviderKind(value: unknown): ProviderKind | null {
  if (value === "codex" || value === "claude") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (value in LEGACY_PROVIDER_ALIASES) {
    return LEGACY_PROVIDER_ALIASES[value as keyof typeof LEGACY_PROVIDER_ALIASES];
  }
  return null;
}

export function resolveProviderKind(
  value: unknown,
  fallback: ProviderKind = "codex",
): ProviderKind {
  return normalizeProviderKind(value) ?? fallback;
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return normalizeProviderKind(value) !== null;
}
