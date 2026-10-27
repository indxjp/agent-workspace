/**
 * `handoff_to_person` for the Claude Agent SDK (ADR-0145 D4, #1302): the model hands the conversation
 * to a person, and the run ends `completed` after one `agent.handoff` frame.
 *
 * The tool only records the reason (`./boundary.ts` holds the run state and builds the in-process MCP
 * server, the only file that imports the SDK); `./engine.ts` turns the record into the frame once the
 * SDK's own `result` has ended the turn. Like `run_skill_script`, the tool is named
 * `mcp__agent-workspace__handoff_to_person`; `compile` adds that name to `allowedTools` when the
 * agent opted in, so a headless run may call it unasked.
 */
import { z } from 'zod';

import { CLAUDE_SKILL_SCRIPT_SERVER } from './skill-script.js';

export const HANDOFF_TOOL = 'handoff_to_person';

/** The name the model sees, and the rule `compile` auto-approves. */
export const CLAUDE_HANDOFF_TOOL = `mcp__${CLAUDE_SKILL_SCRIPT_SERVER}__${HANDOFF_TOOL}`;

export const CLAUDE_HANDOFF_INPUT = z.object({
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe('Why a person should take over, in one or two sentences, for the operator.'),
});

export const HANDOFF_DESCRIPTION =
  'Hand this conversation to a person. Call it when the visitor asks for one or when you cannot ' +
  'help further. After it returns, call no other tool and end your turn.';

export const HANDOFF_RESULT_TEXT =
  'The conversation is handed to a person. Call no further tools and end your turn with one short sentence telling the user a person will take over.';

/** What the run remembers of a handoff; the first call wins. */
export type RecordedHandoff = { readonly reason: string };
