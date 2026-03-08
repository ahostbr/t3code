/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude provider adapter.
 *
 * Uses the local `claude` CLI directly in `-p --output-format stream-json`
 * mode and projects Claude-native events into canonical provider runtime
 * events consumed by the existing orchestration pipeline.
 *
 * @module ClaudeAdapterLive
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claude" as const;
const SESSION_STARTED_MESSAGE = "Claude CLI session ready";
type ClaudeChildProcess = ReturnType<typeof spawn>;

type ClaudePermissionMode = "bypassPermissions" | "default" | "plan";

interface ClaudeResumeCursor {
  readonly sessionId: string;
  readonly assistantMessageId?: string;
}

interface ClaudePendingRequest {
  readonly requestId: RuntimeRequestId;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly requestType: CanonicalRequestType;
  readonly detail: string;
  readonly turnId: TurnId;
}

interface ClaudeContentBlockState {
  readonly index: number;
  readonly type: string;
  readonly itemId?: RuntimeItemId;
  readonly toolUseId?: string;
  readonly toolName?: string;
  inputJson: string;
}

interface ClaudeMessageState {
  readonly messageId: string;
  assistantText: string;
  reasoningText: string;
  assistantItemId?: RuntimeItemId;
  reasoningItemId?: RuntimeItemId;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly child: ClaudeChildProcess;
  readonly items: unknown[];
  readonly contentBlocks: Map<number, ClaudeContentBlockState>;
  currentMessage: ClaudeMessageState | null;
  latestAssistantMessageId?: string;
  latestAssistantText?: string;
  resultLine?: Record<string, unknown>;
  sawResult: boolean;
  interrupted: boolean;
  stderr: string;
}

interface ClaudeThreadState {
  readonly threadId: ProviderSession["threadId"];
  readonly providerOptions: NonNullable<ProviderSessionStartInput["providerOptions"]>["claude"] | undefined;
  readonly pendingRequests: Map<string, ClaudePendingRequest>;
  readonly snapshots: Array<{
    readonly id: TurnId;
    readonly assistantMessageId?: string;
    readonly items: ReadonlyArray<unknown>;
  }>;
  cliSessionId: string;
  latestAssistantMessageId: string | undefined;
  activeTurn: ClaudeTurnState | null;
  session: ProviderSession;
}

export interface ClaudeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly spawnProcess?: typeof spawn;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(`claude:${randomUUID()}`);
}

function makeTurnId(): TurnId {
  return TurnId.makeUnsafe(`claude-turn:${randomUUID()}`);
}

function makeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function makeProviderItemId(value: string): ProviderItemId {
  return ProviderItemId.makeUnsafe(value);
}

function makeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function hasErrorTag(cause: unknown, ...tags: ReadonlyArray<string>): boolean {
  if (!cause || typeof cause !== "object" || !("_tag" in cause)) {
    return false;
  }
  const tag = (cause as { _tag?: unknown })._tag;
  return typeof tag === "string" && tags.includes(tag);
}

function asKnownAdapterError(
  cause: unknown,
  ...tags: ReadonlyArray<string>
): ProviderAdapterError | null {
  return hasErrorTag(cause, ...tags) ? (cause as ProviderAdapterError) : null;
}

function decodeResumeCursor(value: unknown): ClaudeResumeCursor | undefined {
  const record = asObject(value);
  const sessionId = asString(record?.sessionId);
  if (!sessionId) {
    return undefined;
  }
  const assistantMessageId = asString(record?.assistantMessageId);
  return assistantMessageId ? { sessionId, assistantMessageId } : { sessionId };
}

function makeResumeCursor(sessionId: string, assistantMessageId?: string): ClaudeResumeCursor {
  return assistantMessageId ? { sessionId, assistantMessageId } : { sessionId };
}

function toPermissionMode(
  runtimeMode: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
): ClaudePermissionMode {
  if (interactionMode === "plan") {
    return "plan";
  }
  return runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

function toolNameToItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "file_change";
    case "Task":
      return "collab_agent_tool_call";
    case "WebSearch":
    case "WebFetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function toolNameToRequestType(toolName: string): CanonicalRequestType {
  switch (toolName) {
    case "Bash":
      return "exec_command_approval";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "file_change_approval";
    case "Read":
    case "Glob":
    case "Grep":
      return "file_read_approval";
    default:
      return "unknown";
  }
}

function itemTitle(itemType: CanonicalItemType, fallback?: string): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "reasoning":
      return "Reasoning";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "dynamic_tool_call":
      return fallback ?? "Tool call";
    default:
      return fallback;
  }
}

function rawSourceForClaudeEvent(
  line: Record<string, unknown>,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  switch (line.type) {
    case "system":
      return "claude.cli.system";
    case "assistant":
      return "claude.cli.assistant";
    case "user":
      return "claude.cli.user";
    case "result":
      return "claude.cli.result";
    default:
      return "claude.cli.stream-event";
  }
}

function rawMethodForClaudeEvent(line: Record<string, unknown>): string | undefined {
  if (line.type === "system") {
    return asString(line.subtype);
  }
  if (line.type === "stream_event") {
    return asString(asObject(line.event)?.type);
  }
  return asString(line.type);
}

function buildBase(input: {
  readonly threadId: ProviderSession["threadId"];
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly requestId?: RuntimeRequestId;
  readonly providerRefs?: ProviderRuntimeEvent["providerRefs"];
  readonly raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload" | "createdAt" | "eventId" | "provider"> {
  return {
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

function buildRuntimeEvent<T extends ProviderRuntimeEvent["type"]>(
  base: Omit<ProviderRuntimeEvent, "type" | "payload" | "createdAt" | "eventId" | "provider">,
  type: T,
  payload: Extract<ProviderRuntimeEvent, { type: T }>["payload"],
): Extract<ProviderRuntimeEvent, { type: T }> {
  return {
    eventId: makeEventId(),
    provider: PROVIDER,
    createdAt: nowIso(),
    ...base,
    type,
    payload,
  } as Extract<ProviderRuntimeEvent, { type: T }>;
}

function summarizeToolInput(value: unknown): string | undefined {
  const record = asObject(value);
  if (!record) {
    return undefined;
  }
  const candidates = [
    asString(record.command),
    asString(record.description),
    asString(record.file_path),
    asString(record.filePath),
    asString(record.path),
    asString(record.prompt),
    asString(record.query),
  ];
  return candidates.find((candidate) => candidate && candidate.trim().length > 0)?.trim();
}

function looksLikePermissionPrompt(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return (
    lower.includes("permission") ||
    lower.includes("approval") ||
    lower.includes("approve") ||
    lower.includes("can you allow") ||
    lower.includes("would you like me to")
  );
}

function extractToolResultText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const record = asObject(entry);
        return asString(record?.text) ?? asString(record?.content) ?? JSON.stringify(entry);
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

const makeClaudeAdapter = (options?: ClaudeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    const spawnProcess = options?.spawnProcess ?? spawn;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const threads = new Map<ProviderSession["threadId"], ClaudeThreadState>();

    const offerEvent = (event: ProviderRuntimeEvent): void => {
      try {
        Effect.runSync(Queue.offer(runtimeEventQueue, event));
      } catch {
        // Queue shutdown during teardown should not crash callbacks.
      }
    };

    const writeNativeEvent = (threadId: ProviderSession["threadId"], event: unknown): void => {
      if (!nativeEventLogger) {
        return;
      }
      Effect.runFork(nativeEventLogger.write(event, threadId));
    };

    const emitRuntimeWarning = (
      threadId: ProviderSession["threadId"],
      message: string,
      detail?: unknown,
      turnId?: TurnId,
    ): void => {
      offerEvent(
        buildRuntimeEvent(buildBase({ threadId, ...(turnId ? { turnId } : {}) }), "runtime.warning", {
          message,
          ...(detail !== undefined ? { detail } : {}),
        }),
      );
    };

    const emitRuntimeError = (
      threadId: ProviderSession["threadId"],
      message: string,
      detail?: unknown,
      turnId?: TurnId,
    ): void => {
      offerEvent(
        buildRuntimeEvent(buildBase({ threadId, ...(turnId ? { turnId } : {}) }), "runtime.error", {
          message,
          class: "provider_error",
          ...(detail !== undefined ? { detail } : {}),
        }),
      );
    };

    const sessionNotFound = (threadId: ProviderSession["threadId"]) =>
      new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });

    const updateSession = (thread: ClaudeThreadState, patch: Partial<ProviderSession>) => {
      thread.session = {
        ...thread.session,
        ...patch,
        updatedAt: nowIso(),
      };
      return thread.session;
    };

    const finalizeMessageItems = (thread: ClaudeThreadState, turn: ClaudeTurnState): void => {
      const message = turn.currentMessage;
      if (!message) {
        return;
      }

      if (message.reasoningItemId) {
        offerEvent(
          buildRuntimeEvent(
            buildBase({
              threadId: thread.threadId,
              turnId: turn.turnId,
              itemId: message.reasoningItemId,
              providerRefs: {
                providerTurnId: turn.turnId,
                providerItemId: makeProviderItemId(message.messageId),
              },
            }),
            "item.completed",
            {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              ...(message.reasoningText.trim().length > 0
                ? { detail: message.reasoningText.trim() }
                : {}),
            },
          ),
        );
        turn.items.push({ itemId: message.reasoningItemId, itemType: "reasoning" });
      }

      if (message.assistantItemId) {
        const assistantText = message.assistantText.trim();
        if (assistantText.length > 0) {
          turn.latestAssistantText = assistantText;
        }
        offerEvent(
          buildRuntimeEvent(
            buildBase({
              threadId: thread.threadId,
              turnId: turn.turnId,
              itemId: message.assistantItemId,
              providerRefs: {
                providerTurnId: turn.turnId,
                providerItemId: makeProviderItemId(message.messageId),
              },
            }),
            "item.completed",
            {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(assistantText.length > 0 ? { detail: assistantText } : {}),
            },
          ),
        );
        turn.items.push({ itemId: message.assistantItemId, itemType: "assistant_message" });
      }

      turn.latestAssistantMessageId = message.messageId;
      thread.latestAssistantMessageId = message.messageId;
      turn.currentMessage = null;
    };

    const handleToolResult = (
      thread: ClaudeThreadState,
      turn: ClaudeTurnState,
      line: Record<string, unknown>,
    ): void => {
      const message = asObject(line.message);
      const contentEntries = asArray(message?.content) ?? [];
      for (const entry of contentEntries) {
        const record = asObject(entry);
        if (!record || asString(record.type) !== "tool_result") {
          continue;
        }
        const toolUseId = asString(record.tool_use_id);
        if (!toolUseId) {
          continue;
        }
        const toolState = Array.from(turn.contentBlocks.values()).find(
          (candidate) => candidate.toolUseId === toolUseId,
        );
        const toolName = toolState?.toolName ?? "Tool";
        const itemType = toolNameToItemType(toolName);
        const itemId = toolState?.itemId ?? makeItemId(`claude:item:tool:${toolUseId}`);
        const resultText = extractToolResultText(record.content);
        const isError = asBoolean(record.is_error) ?? false;
        offerEvent(
          buildRuntimeEvent(
            buildBase({
              threadId: thread.threadId,
              turnId: turn.turnId,
              itemId,
              providerRefs: {
                providerTurnId: turn.turnId,
                providerItemId: makeProviderItemId(toolUseId),
              },
              raw: {
                source: "claude.cli.user",
                method: "tool_result",
                payload: line,
              },
            }),
            "item.completed",
            {
              itemType,
              status: isError ? "failed" : "completed",
              ...(itemTitle(itemType, toolName) ? { title: itemTitle(itemType, toolName) } : {}),
              ...(resultText.trim().length > 0 ? { detail: resultText.trim() } : {}),
              ...(line.tool_use_result !== undefined ? { data: line.tool_use_result } : {}),
            },
          ),
        );
        turn.items.push({ itemId, itemType });
      }
    };

    const handleStreamEvent = (
      thread: ClaudeThreadState,
      turn: ClaudeTurnState,
      line: Record<string, unknown>,
    ): void => {
      const event = asObject(line.event);
      const eventType = asString(event?.type);
      if (!event || !eventType) {
        return;
      }

      if (eventType === "message_start") {
        const message = asObject(event.message);
        const messageId = asString(message?.id);
        if (!messageId) {
          return;
        }
        finalizeMessageItems(thread, turn);
        turn.currentMessage = {
          messageId,
          assistantText: "",
          reasoningText: "",
        };
        return;
      }

      if (eventType === "content_block_start") {
        const index = asNumber(event.index);
        const block = asObject(event.content_block);
        const type = asString(block?.type);
        if (index === undefined || !type) {
          return;
        }
        const message = turn.currentMessage;
        if (type === "thinking" && message) {
          const itemId = makeItemId(`claude:item:reasoning:${turn.turnId}:${message.messageId}:${index}`);
          message.reasoningItemId = itemId;
          offerEvent(
            buildRuntimeEvent(
              buildBase({
                threadId: thread.threadId,
                turnId: turn.turnId,
                itemId,
                providerRefs: {
                  providerTurnId: turn.turnId,
                  providerItemId: makeProviderItemId(message.messageId),
                },
              }),
              "item.started",
              {
                itemType: "reasoning",
                status: "inProgress",
                title: "Reasoning",
              },
            ),
          );
          turn.contentBlocks.set(index, { index, type, itemId, inputJson: "" });
          return;
        }
        if (type === "text" && message) {
          const itemId = makeItemId(`claude:item:assistant:${turn.turnId}:${message.messageId}`);
          message.assistantItemId = itemId;
          offerEvent(
            buildRuntimeEvent(
              buildBase({
                threadId: thread.threadId,
                turnId: turn.turnId,
                itemId,
                providerRefs: {
                  providerTurnId: turn.turnId,
                  providerItemId: makeProviderItemId(message.messageId),
                },
              }),
              "item.started",
              {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant message",
              },
            ),
          );
          turn.contentBlocks.set(index, { index, type, itemId, inputJson: "" });
          return;
        }
        if (type === "tool_use") {
          const toolUseId = asString(block?.id) ?? `toolu_${randomUUID()}`;
          const toolName = asString(block?.name) ?? "Tool";
          const itemId = makeItemId(`claude:item:tool:${toolUseId}`);
          const itemType = toolNameToItemType(toolName);
          offerEvent(
            buildRuntimeEvent(
              buildBase({
                threadId: thread.threadId,
                turnId: turn.turnId,
                itemId,
                providerRefs: {
                  providerTurnId: turn.turnId,
                  providerItemId: makeProviderItemId(toolUseId),
                },
              }),
              "item.started",
              {
                itemType,
                status: "inProgress",
                ...(itemTitle(itemType, toolName) ? { title: itemTitle(itemType, toolName) } : {}),
                detail: toolName,
              },
            ),
          );
          turn.contentBlocks.set(index, {
            index,
            type,
            itemId,
            toolUseId,
            toolName,
            inputJson: JSON.stringify(block?.input ?? {}),
          });
        }
        return;
      }

      if (eventType === "content_block_delta") {
        const index = asNumber(event.index);
        const delta = asObject(event.delta);
        const deltaType = asString(delta?.type);
        if (index === undefined || !delta || !deltaType) {
          return;
        }
        const block = turn.contentBlocks.get(index);
        const message = turn.currentMessage;
        if (deltaType === "thinking_delta" && block?.itemId && message) {
          const text = asString(delta.thinking) ?? "";
          message.reasoningText += text;
          if (text.length > 0) {
            offerEvent(
              buildRuntimeEvent(
                buildBase({
                  threadId: thread.threadId,
                  turnId: turn.turnId,
                  itemId: block.itemId,
                }),
                "content.delta",
                {
                  streamKind: "reasoning_text",
                  delta: text,
                  contentIndex: index,
                },
              ),
            );
          }
          return;
        }
        if (deltaType === "text_delta" && block?.itemId && message) {
          const text = asString(delta.text) ?? "";
          message.assistantText += text;
          if (text.length > 0) {
            offerEvent(
              buildRuntimeEvent(
                buildBase({
                  threadId: thread.threadId,
                  turnId: turn.turnId,
                  itemId: block.itemId,
                }),
                "content.delta",
                {
                  streamKind: "assistant_text",
                  delta: text,
                  contentIndex: index,
                },
              ),
            );
          }
          return;
        }
        if (deltaType === "input_json_delta" && block) {
          block.inputJson += asString(delta.partial_json) ?? "";
        }
        return;
      }

      if (eventType === "message_stop") {
        finalizeMessageItems(thread, turn);
      }
    };

    const completeTurn = (thread: ClaudeThreadState, turn: ClaudeTurnState): void => {
      finalizeMessageItems(thread, turn);
      const result = turn.resultLine ?? {};
      const isError = asBoolean(result.is_error) ?? false;
      const stopReason = asString(result.stop_reason) ?? null;
      const errorMessage = (() => {
        if (!isError) {
          return undefined;
        }
        if (typeof result.result === "string" && result.result.trim().length > 0) {
          return result.result.trim();
        }
        const errors = (asArray(result.errors) ?? [])
          .map((entry) => asString(entry)?.trim())
          .filter((entry): entry is string => Boolean(entry && entry.length > 0));
        return errors.length > 0 ? errors.join("\n") : undefined;
      })();
      const state = turn.interrupted ? "interrupted" : isError ? "failed" : "completed";

      const permissionDenials = asArray(result.permission_denials) ?? [];
      if (permissionDenials.length > 0 && looksLikePermissionPrompt(turn.latestAssistantText)) {
        for (const denial of permissionDenials) {
          const record = asObject(denial);
          const toolUseId = asString(record?.tool_use_id);
          const toolName = asString(record?.tool_name);
          if (!record || !toolUseId || !toolName) {
            continue;
          }
          const requestId = makeRequestId(`claude:request:${toolUseId}`);
          const pendingRequest: ClaudePendingRequest = {
            requestId,
            toolUseId,
            toolName,
            requestType: toolNameToRequestType(toolName),
            detail:
              turn.latestAssistantText ??
              summarizeToolInput(record.tool_input) ??
              `Approval requested for ${toolName}`,
            turnId: turn.turnId,
          };
          thread.pendingRequests.set(requestId, pendingRequest);
          offerEvent(
            buildRuntimeEvent(
              buildBase({
                threadId: thread.threadId,
                turnId: turn.turnId,
                requestId,
                providerRefs: {
                  providerTurnId: turn.turnId,
                  providerRequestId: toolUseId,
                },
              }),
              "request.opened",
              {
                requestType: pendingRequest.requestType,
                detail: pendingRequest.detail,
                ...(record.tool_input !== undefined ? { args: record.tool_input } : {}),
              },
            ),
          );
        }
      }

      offerEvent(
        buildRuntimeEvent(
          buildBase({
            threadId: thread.threadId,
            turnId: turn.turnId,
            raw: {
              source: "claude.cli.result",
              method: asString(result.subtype) ?? "result",
              payload: result,
            },
          }),
          "turn.completed",
          {
            state,
            stopReason,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(asObject(result.modelUsage) ? { modelUsage: asObject(result.modelUsage) } : {}),
            ...(asNumber(result.total_cost_usd) !== undefined
              ? { totalCostUsd: asNumber(result.total_cost_usd) }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
        ),
      );

      updateSession(thread, {
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: makeResumeCursor(thread.cliSessionId, thread.latestAssistantMessageId),
        ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
      });
      thread.snapshots.push({
        id: turn.turnId,
        ...(turn.latestAssistantMessageId ? { assistantMessageId: turn.latestAssistantMessageId } : {}),
        items: [...turn.items],
      });
      thread.activeTurn = null;

      offerEvent(
        buildRuntimeEvent(buildBase({ threadId: thread.threadId }), "session.state.changed", {
          state: "ready",
        }),
      );
    };

    const attachProcess = (
      thread: ClaudeThreadState,
      turn: ClaudeTurnState,
      child: ClaudeChildProcess,
    ): void => {
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        emitRuntimeError(
          thread.threadId,
          "Claude CLI process did not expose piped stdio streams.",
          { stdio: child.stdio.map((entry) => (entry === null ? "null" : typeof entry)) },
          turn.turnId,
        );
        return;
      }
      const stdoutReader = readline.createInterface({ input: stdout });

      stdoutReader.on("line", (rawLine) => {
        if (rawLine.trim().length === 0) {
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawLine) as Record<string, unknown>;
        } catch (error) {
          emitRuntimeWarning(
            thread.threadId,
            "Failed to parse Claude CLI stream event.",
            { line: rawLine, error: toMessage(error, "JSON parse failed") },
            turn.turnId,
          );
          return;
        }

        writeNativeEvent(thread.threadId, parsed);

        if (parsed.type === "system") {
          if (parsed.subtype === "init") {
            const sessionId = asString(parsed.session_id);
            if (sessionId) {
              thread.cliSessionId = sessionId;
              updateSession(thread, {
                resumeCursor: makeResumeCursor(sessionId, thread.latestAssistantMessageId),
              });
            }
          }
          if (parsed.subtype === "hook_started") {
            const hookId = asString(parsed.hook_id);
            const hookName = asString(parsed.hook_name);
            const hookEvent = asString(parsed.hook_event);
            if (!hookId || !hookName || !hookEvent) {
              return;
            }
            offerEvent(
              buildRuntimeEvent(
                buildBase({
                  threadId: thread.threadId,
                  turnId: turn.turnId,
                  itemId: makeItemId(`claude:hook:${hookId}`),
                  raw: {
                    source: rawSourceForClaudeEvent(parsed),
                    ...(rawMethodForClaudeEvent(parsed) ? { method: rawMethodForClaudeEvent(parsed) } : {}),
                    payload: parsed,
                  },
                }),
                "hook.started",
                {
                  hookId,
                  hookName,
                  hookEvent,
                },
              ),
            );
          }
          if (parsed.subtype === "hook_response") {
            const hookId = asString(parsed.hook_id);
            const exitCode = asNumber(parsed.exit_code);
            if (!hookId) {
              return;
            }
            offerEvent(
              buildRuntimeEvent(
                buildBase({
                  threadId: thread.threadId,
                  turnId: turn.turnId,
                  itemId: makeItemId(`claude:hook:${hookId}`),
                  raw: {
                    source: rawSourceForClaudeEvent(parsed),
                    ...(rawMethodForClaudeEvent(parsed) ? { method: rawMethodForClaudeEvent(parsed) } : {}),
                    payload: parsed,
                  },
                }),
                "hook.completed",
                {
                  hookId,
                  outcome: exitCode === undefined || exitCode === 0 ? "success" : "error",
                  ...(typeof parsed.output === "string" ? { output: parsed.output } : {}),
                  ...(typeof parsed.stdout === "string" ? { stdout: parsed.stdout } : {}),
                  ...(typeof parsed.stderr === "string" ? { stderr: parsed.stderr } : {}),
                  ...(exitCode !== undefined ? { exitCode } : {}),
                },
              ),
            );
          }
          return;
        }

        if (parsed.type === "stream_event") {
          handleStreamEvent(thread, turn, parsed);
          return;
        }

        if (parsed.type === "assistant") {
          const messageId = asString(asObject(parsed.message)?.id);
          if (messageId) {
            turn.latestAssistantMessageId = messageId;
            thread.latestAssistantMessageId = messageId;
          }
          return;
        }

        if (parsed.type === "user") {
          handleToolResult(thread, turn, parsed);
          return;
        }

        if (parsed.type === "result") {
          turn.resultLine = parsed;
          turn.sawResult = true;
        }
      });

      stderr.on("data", (chunk) => {
        turn.stderr += chunk.toString();
      });
      child.on("error", (error) => {
        turn.stderr += `${toMessage(error, "Failed to start Claude CLI process.")}\n`;
      });
      child.on("close", () => {
        stdoutReader.close();
        if (!turn.sawResult) {
          const stderr = turn.stderr.trim();
          const message =
            stderr.length > 0
              ? `Claude CLI process exited before emitting a result. ${stderr}`
              : "Claude CLI process exited before emitting a result.";
          emitRuntimeError(thread.threadId, message, undefined, turn.turnId);
          turn.resultLine = {
            type: "result",
            subtype: "error",
            is_error: true,
            result: message,
            stop_reason: turn.interrupted ? "interrupted" : "error",
            session_id: thread.cliSessionId,
          };
          turn.sawResult = true;
        }
        completeTurn(thread, turn);
      });
    };

    const buildPrompt = (
      attachments: ReadonlyArray<NonNullable<ProviderSendTurnInput["attachments"]>[number]>,
      input: string | undefined,
    ): string => {
      const promptParts: string[] = [];
      const attachmentPaths = attachments
        .map((attachment) =>
          resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment,
          }),
        )
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (input && input.trim().length > 0) {
        promptParts.push(input.trim());
      }
      if (attachmentPaths.length > 0) {
        promptParts.push(
          [
            "The user attached local files that are available on disk:",
            ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
            "Inspect them if they are relevant to your response.",
          ].join("\n"),
        );
      }
      return promptParts.join("\n\n");
    };

    const spawnTurn = (thread: ClaudeThreadState, input: {
      readonly prompt: string;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
      readonly interactionMode?: ProviderInteractionMode | undefined;
      readonly attachmentPaths?: readonly string[] | undefined;
    }) => {
      if (thread.activeTurn) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Thread '${thread.threadId}' already has a running Claude turn.`,
        });
      }

      const turnId = makeTurnId();
      const permissionMode = toPermissionMode(thread.session.runtimeMode, input.interactionMode);
      const binaryPath = thread.providerOptions?.binaryPath?.trim() || "claude";
      const cwd = thread.session.cwd ?? process.cwd();
      const args = [
        "-p",
        input.prompt,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode",
        permissionMode,
        "--add-dir",
        cwd,
      ];
      if (thread.snapshots.length > 0 || thread.session.resumeCursor) {
        args.push("--resume", thread.cliSessionId);
        const resumeCursor = decodeResumeCursor(thread.session.resumeCursor);
        const resumeAt = resumeCursor?.assistantMessageId ?? thread.latestAssistantMessageId;
        if (resumeAt) {
          args.push("--resume-session-at", resumeAt);
        }
      } else {
        args.push("--session-id", thread.cliSessionId);
      }
      if (input.model) {
        args.push("--model", input.model);
      }
      if (input.effort) {
        args.push("--effort", input.effort);
      }
      for (const attachmentPath of input.attachmentPaths ?? []) {
        args.push("--add-dir", path.dirname(attachmentPath));
      }

      const child = spawnProcess(binaryPath, args, {
        cwd,
        env: {
          ...process.env,
          ...(thread.providerOptions?.homePath?.trim()
            ? { CLAUDE_CONFIG_DIR: thread.providerOptions.homePath.trim() }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const turn: ClaudeTurnState = {
        turnId,
        child,
        items: [],
        contentBlocks: new Map(),
        currentMessage: null,
        sawResult: false,
        interrupted: false,
        stderr: "",
      };
      thread.activeTurn = turn;
      updateSession(thread, {
        status: "running",
        activeTurnId: turnId,
        model: input.model ?? thread.session.model,
        lastError: undefined,
      });

      offerEvent(
        buildRuntimeEvent(buildBase({ threadId: thread.threadId }), "session.state.changed", {
          state: "running",
        }),
      );
      offerEvent(
        buildRuntimeEvent(buildBase({ threadId: thread.threadId, turnId }), "turn.started", {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }),
      );

      attachProcess(thread, turn, child);
      return {
        threadId: thread.threadId,
        turnId,
        resumeCursor: thread.session.resumeCursor,
      };
    };

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.try({
        try: () => {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const existing = threads.get(input.threadId);
          if (existing?.activeTurn) {
            throw new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Claude thread '${input.threadId}' is already active.`,
            });
          }

          const createdAt = nowIso();
          const resumeCursor = decodeResumeCursor(input.resumeCursor);
          const cliSessionId = resumeCursor?.sessionId ?? randomUUID();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : { cwd: process.cwd() }),
            ...(input.model !== undefined ? { model: input.model } : {}),
            threadId: input.threadId,
            ...(resumeCursor
              ? {
                  resumeCursor: makeResumeCursor(
                    cliSessionId,
                    resumeCursor.assistantMessageId,
                  ),
                }
              : {}),
            createdAt,
            updatedAt: createdAt,
          };

          threads.set(input.threadId, {
            threadId: input.threadId,
            providerOptions: input.providerOptions?.claude,
            pendingRequests: new Map(),
            snapshots: [],
            cliSessionId,
            latestAssistantMessageId: resumeCursor?.assistantMessageId,
            activeTurn: null,
            session,
          });

          offerEvent(
            buildRuntimeEvent(buildBase({ threadId: input.threadId }), "session.started", {
              message: SESSION_STARTED_MESSAGE,
              ...(session.resumeCursor !== undefined ? { resume: session.resumeCursor } : {}),
            }),
          );
          offerEvent(
            buildRuntimeEvent(buildBase({ threadId: input.threadId }), "session.configured", {
              config: {
                provider: PROVIDER,
                cwd: session.cwd,
                model: session.model ?? null,
                runtimeMode: session.runtimeMode,
              },
            }),
          );
          offerEvent(
            buildRuntimeEvent(buildBase({ threadId: input.threadId }), "thread.started", {
              providerThreadId: cliSessionId,
            }),
          );
          offerEvent(
            buildRuntimeEvent(buildBase({ threadId: input.threadId }), "session.state.changed", {
              state: "ready",
            }),
          );

          return session;
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterValidationError",
            "ProviderAdapterProcessError",
          ) ??
          new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start Claude session."),
                cause,
              }),
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.try({
        try: () => {
          const thread = threads.get(input.threadId);
          if (!thread) {
            throw sessionNotFound(input.threadId);
          }
          if (thread.session.status === "closed") {
            throw new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          const attachments = input.attachments ?? [];
          const attachmentPaths = attachments
            .map((attachment) =>
              resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              }),
            )
            .filter((value): value is string => typeof value === "string" && value.length > 0);
          if (attachments.length > 0 && attachmentPaths.length !== attachments.length) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: "Failed to resolve one or more Claude attachment paths.",
            });
          }

          return spawnTurn(thread, {
            prompt: buildPrompt(attachments, input.input),
            model: input.model ?? thread.session.model,
            effort: input.modelOptions?.claude?.effort,
            interactionMode: input.interactionMode,
            attachmentPaths,
          });
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterRequestError",
            "ProviderAdapterSessionNotFoundError",
            "ProviderAdapterSessionClosedError",
          ) ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: toMessage(cause, "Failed to start Claude turn."),
                cause,
              }),
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.try({
        try: () => {
          const thread = threads.get(threadId);
          if (!thread) {
            throw sessionNotFound(threadId);
          }
          const activeTurn = thread.activeTurn;
          if (!activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: `Claude thread '${threadId}' does not have an active turn.`,
            });
          }
          if (turnId && activeTurn.turnId !== turnId) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: `Active Claude turn '${activeTurn.turnId}' does not match requested turn '${turnId}'.`,
            });
          }
          activeTurn.interrupted = true;
          activeTurn.child.kill();
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterRequestError",
            "ProviderAdapterSessionNotFoundError",
          ) ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt Claude turn."),
                cause,
              }),
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.try({
        try: () => {
          const thread = threads.get(threadId);
          if (!thread) {
            throw sessionNotFound(threadId);
          }
          if (thread.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "request/respond",
              detail: `Claude thread '${threadId}' is busy with another active turn.`,
            });
          }
          const pendingRequest = thread.pendingRequests.get(requestId);
          if (!pendingRequest) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "request/respond",
              detail: `Unknown Claude request '${requestId}' for thread '${threadId}'.`,
            });
          }

          thread.pendingRequests.delete(requestId);
          offerEvent(
            buildRuntimeEvent(
              buildBase({
                threadId,
                turnId: pendingRequest.turnId,
                requestId: pendingRequest.requestId,
                providerRefs: {
                  providerTurnId: pendingRequest.turnId,
                  providerRequestId: pendingRequest.toolUseId,
                },
              }),
              "request.resolved",
              {
                requestType: pendingRequest.requestType,
                decision,
              },
            ),
          );

          spawnTurn(thread, {
            prompt:
              decision === "accept"
                ? `The user approved the previously denied ${pendingRequest.toolName} request. Continue from the current Claude session and retry that action if it is still needed.`
                : `The user rejected the previously denied ${pendingRequest.toolName} request. Continue without that action and use another approach if needed.`,
            model: thread.session.model,
          });
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterRequestError",
            "ProviderAdapterSessionNotFoundError",
          ) ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "request/respond",
                detail: toMessage(cause, "Failed to respond to Claude request."),
                cause,
              }),
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      answers,
    ) =>
      Effect.try({
        try: () => {
          const thread = threads.get(threadId);
          if (!thread) {
            throw sessionNotFound(threadId);
          }
          if (thread.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "user-input/respond",
              detail: `Claude thread '${threadId}' is busy with another active turn.`,
            });
          }
          offerEvent(
            buildRuntimeEvent(buildBase({ threadId }), "user-input.resolved", {
              answers,
            }),
          );
          spawnTurn(thread, {
            prompt: [
              "The user provided the requested structured input.",
              "Continue from the current Claude session using these answers:",
              "```json",
              JSON.stringify(answers, null, 2),
              "```",
            ].join("\n"),
            model: thread.session.model,
          });
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterRequestError",
            "ProviderAdapterSessionNotFoundError",
          ) ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "user-input/respond",
                detail: toMessage(cause, "Failed to respond to Claude user input."),
                cause,
              }),
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.try({
        try: () => {
        const thread = threads.get(threadId);
        if (!thread) {
          return;
        }
        if (thread.activeTurn) {
          thread.activeTurn.interrupted = true;
          thread.activeTurn.child.kill();
        }
        threads.delete(threadId);
        offerEvent(
          buildRuntimeEvent(buildBase({ threadId }), "session.exited", {
            exitKind: "graceful",
          }),
        );
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/stop",
            detail: toMessage(cause, "Failed to stop Claude session."),
            cause,
          }),
      });

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(threads.values()).map((thread) => thread.session));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => threads.has(threadId));

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.try({
        try: () => {
        const thread = threads.get(threadId);
        if (!thread) {
          throw sessionNotFound(threadId);
        }
        return {
          threadId,
          turns: thread.snapshots.map((snapshot) => ({
            id: snapshot.id,
            items: snapshot.items,
          })),
        };
        },
        catch: (cause) =>
          asKnownAdapterError(cause, "ProviderAdapterSessionNotFoundError") ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/read",
                detail: toMessage(cause, "Failed to read Claude thread."),
                cause,
              }),
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.try({
        try: () => {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const thread = threads.get(threadId);
        if (!thread) {
          throw sessionNotFound(threadId);
        }
        if (thread.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: `Cannot roll back Claude thread '${threadId}' while a turn is active.`,
          });
        }
        if (numTurns >= thread.snapshots.length) {
          thread.snapshots.length = 0;
          thread.latestAssistantMessageId = undefined;
        } else {
          thread.snapshots.splice(thread.snapshots.length - numTurns, numTurns);
          thread.latestAssistantMessageId = thread.snapshots.at(-1)?.assistantMessageId;
        }
        updateSession(thread, {
          resumeCursor: makeResumeCursor(thread.cliSessionId, thread.latestAssistantMessageId),
        });
        return {
          threadId,
          turns: thread.snapshots.map((snapshot) => ({
            id: snapshot.id,
            items: snapshot.items,
          })),
        };
        },
        catch: (cause) =>
          asKnownAdapterError(
            cause,
            "ProviderAdapterValidationError",
            "ProviderAdapterSessionNotFoundError",
            "ProviderAdapterRequestError",
          ) ??
          new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail: toMessage(cause, "Failed to roll back Claude thread."),
                cause,
              }),
      });

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const thread of threads.values()) {
          if (thread.activeTurn) {
            thread.activeTurn.interrupted = true;
            thread.activeTurn.child.kill();
          }
        }
        threads.clear();
      });

    yield* Effect.acquireRelease(
      Effect.void,
      () =>
        Effect.sync(() => {
          for (const thread of threads.values()) {
            if (thread.activeTurn) {
              thread.activeTurn.interrupted = true;
              thread.activeTurn.child.kill();
            }
          }
          threads.clear();
          try {
            Effect.runSync(Queue.shutdown(runtimeEventQueue));
          } catch {
            // Ignore teardown races.
          }
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
