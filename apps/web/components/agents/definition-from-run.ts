import { z } from 'zod';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import {
  AW_CONTROL_SERVER,
  BUILDER_TOOL_NAMES,
  BuilderToolInputSchemas,
  BuilderToolOutputSchemas,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import type { AgentEvent } from '@indx-workspace/sdk/events';

/** One `draft_check` or `draft_save` call: the body it was given and what the tool answered. */
export interface DraftView {
  readonly source: 'check' | 'save';
  readonly body: AgentVersionBody;
  /** `null` while the call has no result yet. */
  readonly result: null | { readonly ok: true } | DraftFailure;
  /** What a `draft_save` result says it saved; `null` for a check, or a result the contract rejects. */
  readonly saved: SavedDraft | null;
}

export interface SavedDraft {
  readonly agentId: string;
  readonly version: number;
}

interface DraftFailure {
  readonly ok: false;
  readonly code: string;
  readonly details: readonly string[];
}

export type BuilderRefusal = 'builder_disabled' | 'builder_model_unavailable';

const SOURCES = { draft_check: 'check', draft_save: 'save' } as const;

const ResultSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      code: z.string().min(1),
      details: z.array(z.string()).optional(),
    })
    .passthrough(),
]);

const UNREADABLE: DraftFailure = { ok: false, code: 'unreadable_result', details: [] };

/**
 * The Builder tool a call names: the bare wire name or the `mcp__aw-control__` form, matched
 * exactly (no trim, no case-fold). Anything else is not the Builder's.
 */
export function builderToolName(name: string): BuilderToolName | null {
  const prefix = `mcp__${AW_CONTROL_SERVER}__`;
  const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return BUILDER_TOOL_NAMES.find((tool) => tool === bare) ?? null;
}

/** A tool output as JSON, or `undefined` when it is not JSON. */
function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function readResult(parsed: unknown): { readonly ok: true } | DraftFailure {
  const result = ResultSchema.safeParse(parsed);
  if (!result.success) return UNREADABLE;
  return result.data.ok
    ? { ok: true }
    : { ok: false, code: result.data.code, details: result.data.details ?? [] };
}

function savedIn(parsed: unknown): SavedDraft | null {
  const result = BuilderToolOutputSchemas.draft_save.safeParse(parsed);
  return result.success ? { agentId: result.data.agentId, version: result.data.version } : null;
}

/** The output of each tool call, by call id. */
function outputsById(events: readonly AgentEvent[]): ReadonlyMap<string, string> {
  const outputs = new Map<string, string>();
  for (const event of events) {
    if (event.frame === 'agent.tool.result') outputs.set(event.toolCallId, event.output);
  }
  return outputs;
}

/**
 * The drafts the Builder wrote, in stream order. A draft is read from the tool call's input, which
 * is what the tool received, and never from assistant text. An input that is not a valid draft is
 * skipped rather than shown.
 */
export function draftsFrom(events: readonly AgentEvent[]): readonly DraftView[] {
  const outputs = outputsById(events);
  const drafts: DraftView[] = [];
  for (const event of events) {
    if (event.frame !== 'agent.tool.call') continue;
    const tool = builderToolName(event.name);
    if (tool !== 'draft_check' && tool !== 'draft_save') continue;
    const input = BuilderToolInputSchemas[tool].safeParse(event.input);
    if (!input.success) continue;
    const output = outputs.get(event.toolCallId);
    const parsed = output === undefined ? undefined : parseJson(output);
    drafts.push({
      source: SOURCES[tool],
      body: input.data.body,
      result: output === undefined ? null : readResult(parsed),
      saved: tool === 'draft_save' ? savedIn(parsed) : null,
    });
  }
  return drafts;
}

/** The refusal code that says the Builder cannot run here, when a Builder tool answered with one. */
export function builderRefusalIn(events: readonly AgentEvent[]): BuilderRefusal | null {
  const outputs = outputsById(events);
  for (const event of events) {
    if (event.frame !== 'agent.tool.call' || builderToolName(event.name) === null) continue;
    const output = outputs.get(event.toolCallId);
    if (output === undefined) continue;
    const result = readResult(parseJson(output));
    if (
      !result.ok &&
      (result.code === 'builder_disabled' || result.code === 'builder_model_unavailable')
    ) {
      return result.code;
    }
  }
  return null;
}
