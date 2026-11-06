/**
 * The agent panel's wire (issue #1509): the paths, bodies and answers `agentPanelRoutes` in
 * `./server` serves and `AgentPanel` in `./react` sends and reads. One module, so the two halves
 * cannot drift. Pure Zod, with no server or browser dependency; not a public entry point.
 */
import {
  MAX_PROMPT_CHARS,
  RUN_STATUSES,
  RunApprovalCallSchema,
  type RunApprovalCall,
} from '@indx-workspace/contracts/runs';
import { z } from 'zod';

/** Where the panel's routes are: `app/api/agent-panel/[...path]/route.ts`. */
const AGENT_PANEL_BASE_PATH = '/api/agent-panel';

/** The panel's name for an agent: lower-case, starting with a letter, at most 63 characters. */
const AGENT_KEY = /^[a-z][a-z0-9_-]{0,62}$/u;

/** The panel's name for an agent, as a schema. */
export const AgentKeySchema = z.string().regex(AGENT_KEY);

/** `POST …/runs`: which offered agent, and what the person asks it about the record. */
export const AgentPanelStartRequestSchema = z.strictObject({
  agent: AgentKeySchema,
  prompt: z
    .string()
    .max(MAX_PROMPT_CHARS)
    .refine((prompt) => prompt.trim().length > 0, { message: 'prompt must not be blank' }),
});

/**
 * A run as the panel shows it: its id, its status, the call it waits on while `awaiting_approval`
 * (`null` otherwise), and the safe public failure text.
 */
export interface AgentPanelRun {
  readonly id: string;
  readonly status: (typeof RUN_STATUSES)[number];
  readonly pendingApproval: RunApprovalCall | null;
  readonly error: string | null;
}

/** {@link AgentPanelRun}, as a strict schema. */
const AgentPanelRunSchema: z.ZodType<AgentPanelRun> = z.strictObject({
  id: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  pendingApproval: RunApprovalCallSchema.nullable(),
  error: z.string().nullable(),
});

/** `GET …/runs/:runId`. */
export const AgentPanelRunResponseSchema = z.strictObject({ run: AgentPanelRunSchema });

/** The `202` of `POST …/runs` and of `POST …/runs/:runId/approval`: the run and its stream. */
export interface AgentPanelStartResponse {
  readonly run: AgentPanelRun;
  /** The panel's own events route of the run, on the app's origin. */
  readonly events: string;
}

/** {@link AgentPanelStartResponse}, as a strict schema. */
export const AgentPanelStartResponseSchema: z.ZodType<AgentPanelStartResponse> = z.strictObject({
  run: AgentPanelRunSchema,
  events: z.string().min(1),
});

/** The path of the panel of `recordId` of `resource`, then `rest`, each segment encoded. */
export function agentPanelPath(
  resource: string,
  recordId: string,
  ...rest: readonly string[]
): string {
  return [AGENT_PANEL_BASE_PATH, ...[resource, recordId, ...rest].map(encodeURIComponent)].join(
    '/',
  );
}
