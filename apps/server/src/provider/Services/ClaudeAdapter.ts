/**
 * ClaudeAdapter - Claude implementation of the generic provider adapter contract.
 *
 * This service owns Claude CLI process semantics and emits canonical provider
 * runtime events for Claude-backed sessions.
 *
 * @module ClaudeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claude";
}

export class ClaudeAdapter extends ServiceMap.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Services/ClaudeAdapter",
) {}
